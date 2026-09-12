import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AgentAdapter,
  AgentState,
  Ingest,
  Item,
  ItemOp,
} from '../adapters/adapter.js';
import { AdaptersService } from '../adapters/adapters.service.js';
import {
  DaemonClient,
  DaemonError,
  DaemonSession,
  LogRecord,
} from '../daemon/daemon-client.js';
import { DbService } from '../db/db.service.js';
import { ProjectsService } from '../projects/projects.service.js';

export interface Agent {
  id: string;
  projectId: string;
  name: string;
  profile: string;
  cwd: string;
  vendorConversationId: string | null;
  currentSessionId: string | null;
  createdAt: number;
  archivedAt: number | null;
}

export interface AgentSessionRef {
  daemonSessionId: string;
  startedAt: number;
  endedAt: number | null;
}

export interface AgentStatus {
  state: AgentState;
  error: string | null;
  /** Milliseconds of the last item or state change. */
  lastActivityAt: number;
}

export interface StoredItem {
  index: number;
  sessionId: string;
  /** Daemon record range the item was built from; 0 for synthetic boundary items. */
  seqFrom: number;
  seqTo: number;
  item: Item;
}

export type AgentCounts = Record<AgentState, number>;

interface AgentRow {
  id: string;
  project_id: string;
  name: string;
  profile: string;
  cwd: string;
  vendor_conversation_id: string | null;
  current_session_id: string | null;
  created_at: number;
  archived_at: number | null;
}

/** Per daemon session: its adapter, its cursor, and whether its log has been fully replayed. */
interface SessionLive {
  id: string;
  adapter: AgentAdapter;
  lastSeq: number;
  /** Every record up to the daemon's lastSeq at the time of the last attach has been ingested. */
  replayed: boolean;
  /** An attach with replay is in flight. */
  attaching: boolean;
  /** Exit notice that arrived while replaying; applied once replay completes. */
  pendingExit: DaemonSession | null;
  keys: Map<string, number>;
}

/** Everything about an agent that is rebuilt from the daemon, never stored. */
interface Live {
  sessions: Map<string, SessionLive>;
  status: AgentStatus;
  items: StoredItem[];
  /** Serialises commands and rebuilds for this agent. */
  lock: Promise<unknown>;
  /** True once every known session has been replayed at least once. */
  rebuilt: boolean;
}

export interface AgentEvents {
  state: [agentId: string, projectId: string, status: AgentStatus];
  item: [agentId: string, item: StoredItem];
  session: [agentId: string, session: AgentSessionRef];
  counts: [projectId: string, counts: AgentCounts];
}

export const LABEL_PREFIX = 'agent-manager:';
const STARTING_GRACE_MS = 5000;

const toAgent = (r: AgentRow): Agent => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  profile: r.profile,
  cwd: r.cwd,
  vendorConversationId: r.vendor_conversation_id,
  currentSessionId: r.current_session_id,
  createdAt: r.created_at,
  archivedAt: r.archived_at,
});

const exitWhy = (s: DaemonSession): string =>
  s.exitReason
    ? ` (${s.exitReason})`
    : s.signal
      ? ` (${s.signal})`
      : ` (exit code ${s.exitCode})`;

export function emptyCounts(): AgentCounts {
  return {
    starting: 0,
    idle: 0,
    working: 0,
    'waiting-input': 0,
    'waiting-permission': 0,
    error: 0,
    exited: 0,
  };
}

/**
 * Agents: definitions in SQLite, everything live rebuilt from the daemon.
 * Each daemon session has its own adapter and cursor; records flow through
 * them into items and state. Commands and rebuilds are serialised per
 * agent. On (re)connect every session is replayed from where its cursor
 * stands (from the start after a manager restart), and sessions whose
 * replay failed are retried on the next resync.
 */
@Injectable()
export class AgentsService
  extends EventEmitter<AgentEvents>
  implements OnModuleInit
{
  private readonly logger = new Logger(AgentsService.name);
  private readonly live = new Map<string, Live>();
  /** daemon session id -> agent id, for routing output */
  private readonly sessionOwner = new Map<string, string>();
  private resyncChain: Promise<void> = Promise.resolve();
  private resyncGeneration = 0;

  constructor(
    private readonly dbs: DbService,
    private readonly daemon: DaemonClient,
    private readonly adapters: AdaptersService,
    private readonly projects: ProjectsService,
  ) {
    super();
  }

  private get db() {
    return this.dbs.db;
  }

  onModuleInit(): void {
    this.daemon.on('output', (id, record) => this.onOutput(id, record));
    this.daemon.on('changed', (session) => this.onSessionChanged(session));
    this.daemon.on('connected', () => this.scheduleResync());
  }

  // ---- queries ------------------------------------------------------------

  list(projectId: string): { agent: Agent; status: AgentStatus }[] {
    this.projects.get(projectId);
    return (
      this.db
        .prepare(
          'SELECT * FROM agents WHERE project_id = ? AND archived_at IS NULL ORDER BY created_at',
        )
        .all(projectId) as AgentRow[]
    )
      .map(toAgent)
      .map((agent) => ({ agent, status: this.ensureLive(agent).status }));
  }

  get(id: string): Agent {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as
      AgentRow | undefined;
    if (!row) throw new NotFoundException(`no agent ${id}`);
    return toAgent(row);
  }

  status(id: string): AgentStatus {
    return this.ensureLive(this.get(id)).status;
  }

  sessions(id: string): AgentSessionRef[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM agent_sessions WHERE agent_id = ? ORDER BY started_at, daemon_session_id',
        )
        .all(id) as {
        daemon_session_id: string;
        started_at: number;
        ended_at: number | null;
      }[]
    ).map((r) => ({
      daemonSessionId: r.daemon_session_id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
    }));
  }

  items(id: string, from = 0): StoredItem[] {
    const live = this.ensureLive(this.get(id));
    return from <= 0 ? live.items : live.items.slice(from);
  }

  counts(projectId: string): AgentCounts {
    const counts = emptyCounts();
    for (const { status } of this.list(projectId)) counts[status.state]++;
    return counts;
  }

  // ---- commands -----------------------------------------------------------

  async create(
    projectId: string,
    input: { name?: unknown; profile?: unknown; cwd?: unknown },
  ): Promise<{ agent: Agent; status: AgentStatus }> {
    const project = this.projects.get(projectId);
    const profile = input.profile ?? project.defaultProfile;
    if (typeof input.name !== 'string' || input.name.trim() === '')
      throw new BadRequestException('"name" is required');
    if (typeof profile !== 'string')
      throw new BadRequestException(
        '"profile" is required (or set the project default)',
      );
    if (!this.adapters.supports(profile))
      throw new BadRequestException(`no adapter for profile "${profile}"`);
    if (input.cwd !== undefined && typeof input.cwd !== 'string')
      throw new BadRequestException('"cwd" must be a string');
    // A relative cwd is relative to the project, never to the daemon.
    const cwd = input.cwd
      ? path.resolve(project.path, input.cwd)
      : project.path;
    const others = this.list(projectId).filter(
      (a) => a.agent.cwd === cwd && a.status.state !== 'exited',
    );
    if (others.length)
      this.logger.warn(
        `agent "${input.name}" shares cwd ${cwd} with ${others.map((o) => o.agent.name).join(', ')}; two writers in one tree is on the user`,
      );

    const agent: Agent = {
      id: randomUUID(),
      projectId,
      name: input.name.trim(),
      profile,
      cwd,
      vendorConversationId: null,
      currentSessionId: null,
      createdAt: Date.now(),
      archivedAt: null,
    };
    this.db
      .prepare(
        'INSERT INTO agents (id, project_id, name, profile, cwd, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(agent.id, projectId, agent.name, profile, cwd, agent.createdAt);
    const live = this.ensureLive(agent);
    live.rebuilt = true; // nothing to rebuild for a brand new agent
    await this.withLock(live, () => this.startSession(agent, live));
    return { agent: this.get(agent.id), status: live.status };
  }

  /**
   * Sends a user turn. Refused while a turn is in progress (`agent-busy`),
   * since neither vendor lets us represent a queue faithfully. Starts or
   * resumes a session first if none is live.
   */
  async turn(id: string, text: unknown): Promise<void> {
    if (typeof text !== 'string' || text.length === 0)
      throw new BadRequestException('"text" is required');
    const live = this.ensureLive(this.get(id));
    await this.withLock(live, async () => {
      let agent = this.get(id);
      if (agent.archivedAt) throw new ConflictException('agent is archived');
      await this.awaitStarting(live);
      if (live.status.state === 'working' || live.status.state === 'starting') {
        throw new HttpException(
          {
            statusCode: 409,
            message: 'a turn is in progress',
            code: 'agent-busy',
          },
          409,
        );
      }
      if (!agent.currentSessionId) {
        await this.startSession(agent, live);
        agent = this.get(id);
      }
      const sl = live.sessions.get(agent.currentSessionId!)!;
      for (const line of sl.adapter.turn(text))
        await this.daemon.input(agent.currentSessionId!, line);
      this.setState(agent, live, 'working', null);
    });
  }

  async interrupt(id: string): Promise<void> {
    const live = this.ensureLive(this.get(id));
    await this.withLock(live, async () => {
      const agent = this.get(id);
      const sl = agent.currentSessionId
        ? live.sessions.get(agent.currentSessionId)
        : undefined;
      if (!sl?.adapter.interrupt)
        throw new ConflictException('nothing to interrupt');
      for (const line of sl.adapter.interrupt())
        await this.daemon.input(agent.currentSessionId!, line);
    });
  }

  /** Ends the current session politely; the agent stays resumable. */
  async stop(id: string): Promise<void> {
    const live = this.ensureLive(this.get(id));
    await this.withLock(live, () => this.stopLocked(this.get(id)));
  }

  async archive(id: string): Promise<void> {
    const live = this.ensureLive(this.get(id));
    await this.withLock(live, async () => {
      const agent = this.get(id);
      await this.stopLocked(agent, true);
      this.db
        .prepare('UPDATE agents SET archived_at = ? WHERE id = ?')
        .run(Date.now(), id);
      this.emit('counts', agent.projectId, this.counts(agent.projectId));
    });
  }

  /** Stops every agent of a project and forgets it; called before the project row is deleted. */
  async removeProject(projectId: string): Promise<void> {
    const rows = this.db
      .prepare('SELECT * FROM agents WHERE project_id = ?')
      .all(projectId) as AgentRow[];
    for (const row of rows) {
      const agent = toAgent(row);
      const live = this.ensureLive(agent);
      await this.withLock(live, async () => {
        await this.stopLocked(agent, true);
        for (const sid of live.sessions.keys()) this.sessionOwner.delete(sid);
        this.live.delete(agent.id);
      });
    }
  }

  /**
   * Ends the current session: close stdin, and when `wait` is set, escalate
   * to SIGTERM and SIGKILL if the process lingers, so the caller can rely on
   * it being gone.
   */
  private async stopLocked(agent: Agent, wait = false): Promise<void> {
    const id = agent.currentSessionId;
    if (!id) return;
    try {
      await this.daemon.endInput(id);
    } catch (err) {
      if (!(err instanceof DaemonError) || err.code === 'disconnected')
        throw err;
      await this.daemon.signal(id, 'SIGTERM').catch(() => undefined);
    }
    if (!wait) return;
    for (const [signal, ms] of [
      [null, 3000],
      ['SIGTERM', 2000],
      ['SIGKILL', 2000],
    ] as const) {
      if (signal) await this.daemon.signal(id, signal).catch(() => undefined);
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const s = await this.daemon.getSession(id).catch(() => null);
        if (!s || s.state === 'exited') return;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }

  // ---- sessions -----------------------------------------------------------

  /** Starts a new daemon session for the agent. Ownership is registered before any output is consumed. */
  private async startSession(agent: Agent, live: Live): Promise<void> {
    const adapter = this.adapters.create(agent.profile);
    const session = await this.daemon.start({
      profile: agent.profile,
      args: adapter.startArgs({ resume: agent.vendorConversationId }),
      cwd: agent.cwd,
      label: `${LABEL_PREFIX}${agent.id}`,
    });
    this.db
      .prepare(
        'INSERT INTO agent_sessions (daemon_session_id, agent_id, started_at) VALUES (?, ?, ?)',
      )
      .run(session.id, agent.id, session.startedAt);
    this.db
      .prepare('UPDATE agents SET current_session_id = ? WHERE id = ?')
      .run(session.id, agent.id);
    agent.currentSessionId = session.id;
    const sl = this.trackSession(agent, live, session.id, adapter);
    this.appendItem(agent.id, live, session.id, 0, {
      kind: 'system',
      text: agent.vendorConversationId
        ? `session resumed (${session.id})`
        : `session started (${session.id})`,
    });
    this.setState(agent, live, adapter.initialState ?? 'starting', null);
    this.emit('session', agent.id, {
      daemonSessionId: session.id,
      startedAt: session.startedAt,
      endedAt: null,
    });
    // Attach with replay from the start: anything the process said (or an
    // exit) between start and now is in the log.
    await this.attachSession(agent, live, sl);
    await this.reconcileCurrent(agent, live);
  }

  private trackSession(
    agent: Agent,
    live: Live,
    sessionId: string,
    adapter: AgentAdapter,
  ): SessionLive {
    let sl = live.sessions.get(sessionId);
    if (!sl) {
      sl = {
        id: sessionId,
        adapter,
        lastSeq: 0,
        replayed: false,
        attaching: false,
        pendingExit: null,
        keys: new Map(),
      };
      live.sessions.set(sessionId, sl);
    }
    this.sessionOwner.set(sessionId, agent.id);
    return sl;
  }

  /** Attaches with replay from the session's cursor; records arrive through onOutput before this resolves. */
  private async attachSession(
    agent: Agent,
    live: Live,
    sl: SessionLive,
  ): Promise<void> {
    sl.attaching = true;
    try {
      await this.daemon.attach(sl.id, sl.lastSeq + 1);
      sl.replayed = true;
    } catch (err) {
      sl.replayed = false;
      this.logger.warn(
        `replay of ${sl.id} for agent ${agent.id} failed: ${(err as Error).message}`,
      );
      this.appendItem(agent.id, live, sl.id, 0, {
        kind: 'system',
        text: `history unavailable: ${(err as Error).message}`,
      });
    } finally {
      sl.attaching = false;
    }
    if (sl.pendingExit) {
      const s = sl.pendingExit;
      sl.pendingExit = null;
      this.applyExit(agent, live, s);
    }
  }

  /** After attaching to the current session, make sure a session that already died is treated as such. */
  private async reconcileCurrent(agent: Agent, live: Live): Promise<void> {
    if (!agent.currentSessionId) return;
    try {
      const s = await this.daemon.getSession(agent.currentSessionId);
      if (s.state === 'exited') this.applyExit(agent, live, s);
    } catch (err) {
      if (err instanceof DaemonError && err.code === 'unknown-session') {
        this.applyExit(agent, live, {
          id: agent.currentSessionId,
          state: 'exited',
          exitReason: 'removed',
          exitCode: null,
          signal: null,
          exitedAt: Date.now(),
          startedAt: 0,
          lastSeq: 0,
        } as DaemonSession);
      }
    }
  }

  private onOutput(sessionId: string, record: LogRecord): void {
    const agentId = this.sessionOwner.get(sessionId);
    if (!agentId) return;
    const live = this.live.get(agentId);
    const sl = live?.sessions.get(sessionId);
    if (!live || !sl) return;
    if (record.seq <= sl.lastSeq) return; // overlap after a reconnect
    sl.lastSeq = record.seq;
    const row = this.db
      .prepare('SELECT * FROM agents WHERE id = ?')
      .get(agentId) as AgentRow | undefined;
    if (!row) return;
    this.apply(toAgent(row), live, sl, record, sl.adapter.ingest(record));
  }

  private apply(
    agent: Agent,
    live: Live,
    sl: SessionLive,
    record: LogRecord,
    ingest: Ingest,
  ): void {
    if (
      ingest.conversationId &&
      ingest.conversationId !== agent.vendorConversationId
    ) {
      this.db
        .prepare('UPDATE agents SET vendor_conversation_id = ? WHERE id = ?')
        .run(ingest.conversationId, agent.id);
      agent.vendorConversationId = ingest.conversationId;
    }
    for (const op of ingest.ops ?? [])
      this.applyOp(agent.id, live, sl, record.seq, op);
    // State from a session that is no longer current is history, not now.
    if (ingest.state && sl.id === agent.currentSessionId)
      this.setState(agent, live, ingest.state, ingest.error ?? null);
  }

  private applyOp(
    agentId: string,
    live: Live,
    sl: SessionLive,
    seq: number,
    op: ItemOp,
  ): void {
    if (op.op === 'update') {
      const index = sl.keys.get(op.key);
      if (index !== undefined) {
        const stored = live.items[index];
        stored.item = op.item;
        stored.seqTo = seq;
        live.status.lastActivityAt = Date.now();
        this.emit('item', agentId, stored);
        return;
      }
    }
    const stored = this.appendItem(agentId, live, sl.id, seq, op.item);
    if (op.key) sl.keys.set(op.key, stored.index);
  }

  private onSessionChanged(session: DaemonSession): void {
    if (session.state !== 'exited') return;
    const agentId =
      this.sessionOwner.get(session.id) ??
      (session.label?.startsWith(LABEL_PREFIX)
        ? session.label.slice(LABEL_PREFIX.length)
        : undefined);
    if (!agentId) return;
    const row = this.db
      .prepare('SELECT * FROM agents WHERE id = ?')
      .get(agentId) as AgentRow | undefined;
    if (!row) return;
    const agent = toAgent(row);
    const live = this.ensureLive(agent);
    const sl = live.sessions.get(session.id);
    if (sl?.attaching) {
      sl.pendingExit = session; // the exit boundary goes after the records still being replayed
      return;
    }
    this.applyExit(agent, live, session);
  }

  private applyExit(agent: Agent, live: Live, session: DaemonSession): void {
    this.db
      .prepare(
        'UPDATE agent_sessions SET ended_at = ? WHERE daemon_session_id = ? AND ended_at IS NULL',
      )
      .run(session.exitedAt ?? Date.now(), session.id);
    if (agent.currentSessionId !== session.id) return;
    this.db
      .prepare('UPDATE agents SET current_session_id = NULL WHERE id = ?')
      .run(agent.id);
    agent.currentSessionId = null;
    this.appendItem(agent.id, live, session.id, session.lastSeq, {
      kind: 'system',
      text: `session ended${exitWhy(session)}`,
    });
    this.setState(agent, live, 'exited', null);
    this.emit('session', agent.id, {
      daemonSessionId: session.id,
      startedAt: session.startedAt,
      endedAt: session.exitedAt,
    });
  }

  // ---- resync -------------------------------------------------------------

  private scheduleResync(): void {
    const generation = ++this.resyncGeneration;
    this.resyncChain = this.resyncChain
      .then(() => this.resync(generation))
      .catch((err: Error) =>
        this.logger.error(`resync failed: ${err.message}`),
      );
  }

  /**
   * After (re)connecting to the daemon: rebuild every agent from its
   * sessions. Runs one agent at a time under that agent's lock, so commands
   * wait for the rebuild. A newer resync supersedes an older one mid-way.
   */
  private async resync(generation: number): Promise<void> {
    const sessions = await this.daemon.listSessions();
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const rows = this.db.prepare('SELECT * FROM agents').all() as AgentRow[];
    let done = 0;
    for (const row of rows) {
      if (generation !== this.resyncGeneration) return;
      const agent = toAgent(row);
      const live = this.ensureLive(agent);
      await this.withLock(live, async () => {
        this.adoptSessions(agent, sessions);
        const refs = this.sessions(agent.id);
        for (const ref of refs) {
          if (generation !== this.resyncGeneration) return;
          const s = byId.get(ref.daemonSessionId);
          if (!s) continue;
          const isNew = !live.sessions.has(s.id);
          const sl = this.trackSession(
            agent,
            live,
            s.id,
            live.sessions.get(s.id)?.adapter ??
              this.adapters.create(agent.profile),
          );
          if (isNew)
            this.appendItem(agent.id, live, s.id, 0, {
              kind: 'system',
              text: `${ref === refs[0] ? 'session started' : 'session resumed'} (${s.id})`,
            });
          const isCurrent = s.id === agent.currentSessionId;
          if (!sl.replayed || (isCurrent && s.state === 'running'))
            await this.attachSession(agent, live, sl);
          if (s.state === 'exited' && !sl.pendingExit) {
            if (isCurrent) this.applyExit(agent, live, s);
            else if (isNew)
              this.appendItem(agent.id, live, s.id, s.lastSeq, {
                kind: 'system',
                text: `session ended${exitWhy(s)}`,
              });
            if (ref.endedAt === null)
              this.db
                .prepare(
                  'UPDATE agent_sessions SET ended_at = ? WHERE daemon_session_id = ?',
                )
                .run(s.exitedAt ?? Date.now(), s.id);
          }
        }
        live.rebuilt = [...live.sessions.values()].every((sl) => sl.replayed);
        await this.reconcileCurrent(agent, live);
        if (!agent.currentSessionId && live.status.state !== 'exited')
          this.setState(agent, live, 'exited', null);
      });
      done++;
    }
    this.logger.log(
      `resynced ${done} agent(s) against ${sessions.length} daemon session(s)`,
    );
  }

  /** Sessions the daemon labelled for this agent that the database does not know: record them, and pick a live one as current if we have none. */
  private adoptSessions(agent: Agent, sessions: DaemonSession[]): void {
    const known = new Set(
      this.sessions(agent.id).map((r) => r.daemonSessionId),
    );
    const mine = sessions
      .filter((s) => s.label === `${LABEL_PREFIX}${agent.id}`)
      .sort((a, b) => a.startedAt - b.startedAt);
    for (const s of mine) {
      if (known.has(s.id)) continue;
      this.db
        .prepare(
          'INSERT INTO agent_sessions (daemon_session_id, agent_id, started_at, ended_at) VALUES (?, ?, ?, ?)',
        )
        .run(s.id, agent.id, s.startedAt, s.exitedAt);
      this.logger.log(`adopted daemon session ${s.id} for agent ${agent.id}`);
    }
    if (!agent.currentSessionId) {
      const running = mine.filter((s) => s.state === 'running');
      if (running.length) {
        const current = running[running.length - 1];
        this.db
          .prepare('UPDATE agents SET current_session_id = ? WHERE id = ?')
          .run(current.id, agent.id);
        agent.currentSessionId = current.id;
        for (const extra of running.slice(0, -1)) {
          this.logger.warn(
            `agent ${agent.id} has a second live session ${extra.id}; ending it`,
          );
          void this.daemon.endInput(extra.id).catch(() => undefined);
        }
      }
    }
  }

  // ---- helpers ------------------------------------------------------------

  private ensureLive(agent: Agent): Live {
    let live = this.live.get(agent.id);
    if (!live) {
      live = {
        sessions: new Map(),
        status: {
          state: agent.currentSessionId ? 'starting' : 'exited',
          error: null,
          lastActivityAt: agent.createdAt,
        },
        items: [],
        lock: Promise.resolve(),
        rebuilt: false,
      };
      this.live.set(agent.id, live);
    }
    return live;
  }

  private withLock<T>(live: Live, fn: () => Promise<T>): Promise<T> {
    const run = live.lock.then(fn, fn);
    live.lock = run.catch(() => undefined);
    return run;
  }

  /** Gives a freshly started process a moment to report ready before a turn is judged. */
  private async awaitStarting(live: Live): Promise<void> {
    const until = Date.now() + STARTING_GRACE_MS;
    while (live.status.state === 'starting' && Date.now() < until)
      await new Promise((r) => setTimeout(r, 25));
  }

  private appendItem(
    agentId: string,
    live: Live,
    sessionId: string,
    seq: number,
    item: Item,
  ): StoredItem {
    const stored: StoredItem = {
      index: live.items.length,
      sessionId,
      seqFrom: seq,
      seqTo: seq,
      item,
    };
    live.items.push(stored);
    live.status.lastActivityAt = Date.now();
    this.emit('item', agentId, stored);
    return stored;
  }

  private setState(
    agent: Agent,
    live: Live,
    state: AgentState,
    error: string | null,
  ): void {
    if (live.status.state === state && live.status.error === error) return;
    live.status = { state, error, lastActivityAt: Date.now() };
    this.emit('state', agent.id, agent.projectId, live.status);
    this.emit('counts', agent.projectId, this.counts(agent.projectId));
  }
}
