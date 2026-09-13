import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import type { DaemonSession, LogRecord } from '../src/daemon/daemon-client.js';

type Frame = Record<string, unknown> & { type: string; ref?: string };

export interface ScriptedSession {
  record: DaemonSession;
  log: LogRecord[];
  attached: Set<WebSocket>;
}

/**
 * A daemon the test drives frame by frame. Speaks exactly the part of the
 * daemon protocol the manager's client uses, keeps a log per session
 * (which survives a cut connection, like the real one), and lets the test
 * emit output, react to inputs, refuse an input, cut the connection with
 * or without answering, and end a session. No processes are spawned.
 */
export class ScriptedDaemon extends EventEmitter<{
  input: [sessionId: string, line: unknown, record: LogRecord];
  started: [session: ScriptedSession];
}> {
  readonly sessions = new Map<string, ScriptedSession>();
  /** Every attach seen, with the sequence the client asked to replay from. */
  readonly attaches: { sessionId: string; fromSeq: number }[] = [];
  private readonly server: WebSocketServer;
  private readonly clients = new Set<WebSocket>();
  /** The test sets this to refuse attaches (a session whose log cannot be replayed). */
  onAttach: ((sessionId: string) => 'ok' | 'refuse') | null = null;
  /** The test sets this to shape the answer to the next input (or all inputs). */
  onInput:
    | ((
        sessionId: string,
        line: unknown,
      ) => 'ok' | 'refuse' | 'cut-after' | 'cut-before')
    | null = null;
  readonly url: string;

  private constructor(server: WebSocketServer, port: number) {
    super();
    this.server = server;
    this.url = `ws://127.0.0.1:${port}/`;
    server.on('connection', (ws) => {
      this.clients.add(ws);
      ws.on('close', () => {
        this.clients.delete(ws);
        for (const s of this.sessions.values()) s.attached.delete(ws);
      });
      ws.on('message', (data) =>
        this.onFrame(ws, JSON.parse(String(data)) as Frame),
      );
    });
  }

  static async start(): Promise<ScriptedDaemon> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    return new ScriptedDaemon(server, port);
  }

  async stop(): Promise<void> {
    for (const c of this.clients) c.terminate();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Drops every client connection; the sessions and their logs stay. */
  cut(): void {
    for (const c of this.clients) c.terminate();
  }

  /** Appends a record as if the process wrote it, delivered live to attached clients. */
  emit_(sessionId: string, s: LogRecord['s'], d: unknown): LogRecord {
    const session = this.sessions.get(sessionId)!;
    const record: LogRecord = {
      seq: ++session.record.lastSeq,
      t: Date.now(),
      s,
      d: typeof d === 'string' ? d : JSON.stringify(d),
    };
    session.log.push(record);
    for (const ws of session.attached)
      this.send(ws, { type: 'session.output', id: sessionId, ...record });
    return record;
  }

  out(sessionId: string, line: unknown): LogRecord {
    return this.emit_(sessionId, 'out', line);
  }

  /** Ends the session the way the daemon reports it: session.changed with the full record. */
  exit(sessionId: string, exitCode = 0): void {
    const session = this.sessions.get(sessionId)!;
    session.record = {
      ...session.record,
      state: 'exited',
      exitCode,
      signal: null,
      exitedAt: Date.now(),
    };
    for (const ws of this.clients)
      this.send(ws, { type: 'session.changed', session: session.record });
  }

  /** Inputs recorded for a session, parsed. */
  inputs(sessionId: string): unknown[] {
    return this.sessions
      .get(sessionId)!
      .log.filter((r) => r.s === 'in')
      .map((r) => JSON.parse(r.d));
  }

  private send(ws: WebSocket, frame: Frame): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }

  private reply(ws: WebSocket, req: Frame, frame: Omit<Frame, 'ref'>): void {
    this.send(ws, { ...frame, ref: req.ref } as Frame);
  }

  private error(
    ws: WebSocket,
    req: Frame,
    code: string,
    message: string,
  ): void {
    this.reply(ws, req, { type: 'error', code, message });
  }

  private onFrame(ws: WebSocket, f: Frame): void {
    const id = typeof f.id === 'string' ? f.id : '';
    const session = this.sessions.get(id);
    switch (f.type) {
      case 'sessions.list':
        return this.reply(ws, f, {
          type: 'sessions',
          sessions: [...this.sessions.values()].map((s) => s.record),
        });
      case 'profiles.list':
        return this.reply(ws, f, {
          type: 'profiles',
          profiles: ['claude', 'codex', 'copilot'].map((name) => ({
            name,
            command: name,
            args: [],
            cwd: null,
            env: {},
            loginShell: false,
          })),
        });
      case 'session.get':
        if (!session)
          return this.error(ws, f, 'unknown-session', `no session ${id}`);
        return this.reply(ws, f, { type: 'session', session: session.record });
      case 'session.start': {
        const sid = String(f.id ?? `s-${this.sessions.size + 1}`);
        const record: DaemonSession = {
          id: sid,
          profile: String(f.profile),
          label: (f.label as string) ?? null,
          command: String(f.profile),
          args: (f.args as string[]) ?? [],
          cwd: String(f.cwd ?? '/'),
          state: 'running',
          pid: 4242,
          exitCode: null,
          signal: null,
          exitReason: null,
          startedAt: Date.now(),
          exitedAt: null,
          lastSeq: 0,
        };
        const created: ScriptedSession = {
          record,
          log: [],
          attached: new Set(),
        };
        this.sessions.set(sid, created);
        this.reply(ws, f, { type: 'session.started', session: record });
        this.emit('started', created);
        return;
      }
      case 'session.attach': {
        if (!session)
          return this.error(ws, f, 'unknown-session', `no session ${id}`);
        const from =
          (f.replay as { fromSeq?: number } | undefined)?.fromSeq ?? 1;
        this.attaches.push({ sessionId: id, fromSeq: from });
        if (this.onAttach?.(id) === 'refuse')
          return this.error(ws, f, 'log-error', 'refused by the script');
        let last = from - 1;
        for (const r of session.log)
          if (r.seq >= from) {
            this.send(ws, { type: 'session.output', id, ...r });
            last = r.seq;
          }
        session.attached.add(ws);
        return this.reply(ws, f, {
          type: 'session.attached',
          session: session.record,
          lastSeq: Math.max(last, Math.min(from - 1, session.record.lastSeq)),
        });
      }
      case 'session.input': {
        if (!session)
          return this.error(ws, f, 'unknown-session', `no session ${id}`);
        if (session.record.state !== 'running')
          return this.error(
            ws,
            f,
            'session-not-running',
            'session is not running',
          );
        const verdict = this.onInput?.(id, f.data) ?? 'ok';
        if (verdict === 'refuse')
          return this.error(ws, f, 'stdin-error', 'refused by the script');
        if (verdict === 'cut-before') return ws.terminate(); // never reached the process
        const record = this.emit_(id, 'in', f.data);
        if (verdict === 'cut-after') {
          // recorded, but the acknowledgement is lost with the connection
          ws.terminate();
        } else this.reply(ws, f, { type: 'ok' });
        this.emit('input', id, f.data, record);
        return;
      }
      case 'session.end-input':
      case 'session.signal':
        if (!session)
          return this.error(ws, f, 'unknown-session', `no session ${id}`);
        if (session.record.state !== 'running')
          return this.error(
            ws,
            f,
            'session-not-running',
            'session is not running',
          );
        this.reply(ws, f, { type: 'ok' });
        if (f.type === 'session.signal')
          setTimeout(() => this.exit(id, null as unknown as number), 20);
        return;
      default:
        return this.error(
          ws,
          f,
          'unknown-type',
          `unknown frame type ${f.type}`,
        );
    }
  }
}
