import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { MANAGER_CONFIG } from '../config/config.js';
import type { ManagerConfig } from '../config/config.js';

/** Mirror of the daemon's log record and session record; see agent-daemon/docs/design.md. */
export interface LogRecord {
  seq: number;
  t: number;
  s: 'out' | 'err' | 'in';
  d: string;
}

export interface DaemonSession {
  id: string;
  profile: string;
  label: string | null;
  command: string;
  args: string[];
  cwd: string;
  state: 'running' | 'exited';
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  exitReason: string | null;
  startedAt: number;
  exitedAt: number | null;
  lastSeq: number;
}

export interface DaemonProfile {
  name: string;
  description?: string;
  command: string;
  args: string[];
  cwd: string | null;
  env: Record<string, string>;
  loginShell: boolean;
}

export class DaemonError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface DaemonEvents {
  connected: [];
  disconnected: [];
  output: [id: string, record: LogRecord];
  changed: [session: DaemonSession];
}

type Frame = Record<string, unknown> & { type: string; ref?: string };

/**
 * The manager's single connection to agent-daemon: request/reply with
 * refs, live events, automatic reconnect. Attachments are the caller's to
 * redo after `connected`. Listener errors are logged and never allowed to
 * break the socket handling.
 */
@Injectable()
export class DaemonClient
  extends EventEmitter<DaemonEvents>
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(DaemonClient.name);
  private ws: WebSocket | null = null;
  private pending = new Map<
    string,
    { resolve: (f: Frame) => void; reject: (e: Error) => void }
  >();
  private nextRef = 1;
  private closing = false;
  private backoff = 500;
  private reconnectTimer: NodeJS.Timeout | null = null;
  connected = false;

  constructor(@Inject(MANAGER_CONFIG) private readonly config: ManagerConfig) {
    super();
  }

  onModuleInit(): void {
    this.connect();
  }

  onModuleDestroy(): void {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    // Nobody should react to the socket closing during shutdown; the
    // services listening are being torn down too.
    this.removeAllListeners();
    this.ws?.close();
  }

  private connect(): void {
    if (this.closing) return;
    const ws = new WebSocket(this.config.daemonUrl);
    this.ws = ws;
    ws.on('open', () => {
      this.logger.log(`connected to daemon at ${this.config.daemonUrl}`);
      this.backoff = 500;
      this.connected = true;
      this.safeEmit('connected');
    });
    ws.on('message', (data) => {
      let frame: Frame;
      try {
        frame = JSON.parse(String(data)) as Frame;
      } catch {
        this.logger.warn('daemon sent a frame that is not JSON');
        return;
      }
      this.onFrame(frame);
    });
    ws.on('error', (err) =>
      this.logger.warn(`daemon socket error: ${err.message}`),
    );
    ws.on('close', () => {
      const was = this.connected;
      this.connected = false;
      this.ws = null;
      for (const p of this.pending.values())
        p.reject(new DaemonError('disconnected', 'daemon connection lost'));
      this.pending.clear();
      // Reconnect is scheduled before subscribers run, so a subscriber
      // that throws cannot leave the manager disconnected for good.
      if (!this.closing) {
        this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 10_000);
      }
      if (was) this.safeEmit('disconnected');
    });
  }

  private safeEmit<K extends keyof DaemonEvents>(
    event: K,
    ...args: DaemonEvents[K]
  ): void {
    try {
      (this.emit as (e: string, ...a: unknown[]) => boolean)(event, ...args);
    } catch (err) {
      this.logger.error(
        `listener for ${String(event)} failed: ${(err as Error).stack ?? err}`,
      );
    }
  }

  private onFrame(f: Frame): void {
    if (f.ref !== undefined && this.pending.has(String(f.ref))) {
      const p = this.pending.get(String(f.ref))!;
      this.pending.delete(String(f.ref));
      if (f.type === 'error')
        p.reject(new DaemonError(String(f.code), String(f.message)));
      else p.resolve(f);
      return;
    }
    switch (f.type) {
      case 'session.output': {
        const { id, seq, t, s, d } = f as unknown as { id: string } & LogRecord;
        this.safeEmit('output', id, { seq, t, s, d });
        return;
      }
      case 'session.changed':
        this.safeEmit('changed', f.session as DaemonSession);
        return;
      case 'error':
        this.logger.warn(
          `daemon error without ref: ${String(f.code)} ${String(f.message)}`,
        );
        return;
      default:
        return; // session.exit is followed by session.changed with the full record
    }
  }

  request<T extends Frame = Frame>(frame: Omit<Frame, 'ref'>): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new DaemonError('disconnected', 'daemon is not connected'),
      );
    }
    const ref = String(this.nextRef++);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(ref, { resolve: resolve as (f: Frame) => void, reject });
      this.ws!.send(JSON.stringify({ ...frame, ref }));
    });
  }

  listSessions(): Promise<DaemonSession[]> {
    return this.request<Frame & { sessions: DaemonSession[] }>({
      type: 'sessions.list',
    }).then((r) => r.sessions);
  }

  getSession(id: string): Promise<DaemonSession> {
    return this.request<Frame & { session: DaemonSession }>({
      type: 'session.get',
      id,
    }).then((r) => r.session);
  }

  listProfiles(): Promise<DaemonProfile[]> {
    return this.request<Frame & { profiles: DaemonProfile[] }>({
      type: 'profiles.list',
    }).then((r) => r.profiles);
  }

  /** Starts a session without attaching; the caller attaches with replay once it owns the id. */
  start(req: {
    profile: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    label?: string;
  }): Promise<DaemonSession> {
    return this.request<Frame & { session: DaemonSession }>({
      type: 'session.start',
      ...req,
    }).then((r) => r.session);
  }

  /** Attaches with replay from `fromSeq`; replayed records arrive as `output` events before this resolves. */
  attach(id: string, fromSeq: number): Promise<number> {
    return this.request<Frame & { lastSeq: number }>({
      type: 'session.attach',
      id,
      replay: { fromSeq },
    }).then((r) => r.lastSeq);
  }

  async input(id: string, data: unknown): Promise<void> {
    await this.request({ type: 'session.input', id, data });
  }

  async endInput(id: string): Promise<void> {
    await this.request({ type: 'session.end-input', id });
  }

  async signal(
    id: string,
    signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL',
  ): Promise<void> {
    await this.request({ type: 'session.signal', id, signal });
  }
}
