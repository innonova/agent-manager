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
import { randomUUID } from 'node:crypto';
import type {
  AgentAdapter,
  AgentState,
  Ingest,
  Item,
  ItemOp,
  Permissions,
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
  /** Set at creation and applied when a session starts; `ask` makes gated tools wait for the human. */
  permissions: Permissions;
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
  /** Background jobs the agent left running; it starts a turn by itself when they finish. */
  background: number;
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
  permissions: string | null;
  current_session_id: string | null;
  created_at: number;
  archived_at: number | null;
}

/** Per daemon session: its adapter, its cursor, and whether its log has been caught up. */
interface SessionLive {
  id: string;
  adapter: AgentAdapter;
  lastSeq: number;
  /** The last attach with replay on the current socket succeeded; the cursor is at the daemon's boundary as of then. */
  replayed: boolean;
  /** The log has been replayed to the daemon's boundary at least once (survives a socket loss). */
  complete: boolean;
  attaching: boolean;
  /** Exit notice that arrived before the log was replayed; applied once it is. */
  pendingExit: DaemonSession | null;
  /** Exit already applied (state, pointer) but its boundary item waits for the replay to finish. */
  pendingBoundary: DaemonSession | null;
  /** Records are ignored (not even cursored) until the next replay attach; set while a rebuild is pending. */
  suspended: boolean;
  /** Boundary items written for this session, so a rebuild can write them again. */
  startedBoundary: boolean;
  endedBoundary: boolean;
  keys: Map<string, number>;
  /** Handshake lines produced while a replay was in flight, with the seq that produced them. */
  pendingSends: { seq: number; lines: unknown[] }[];
}

/** Everything about an agent that is rebuilt from the daemon, never stored. */
interface Live {
  sessions: Map<string, SessionLive>;
  status: AgentStatus;
  items: StoredItem[];
  /** Serialises commands and rebuilds for this agent. */
  lock: Promise<unknown>;
  /** Resolves once the pending resync has handled this agent; commands wait for it. */
  synced: Promise<void>;
  markSynced: () => void;
  syncPending: boolean;
  /** Sessions may exist that the database does not know; cleared only after an adoption pass succeeds. */
  adoptionNeeded: boolean;
  /** User ids of turns sent and not yet seen back as input records, in order. */
  pendingAuthors: string[];
  /**
   * The status changed while a replay was in flight and has not been
   * announced: states derived from history are applied silently and only
   * the state at the end of the replay is emitted, so listeners (the
   * feature queue above all) never act on a transition that is long past.
   */
  stateHeld: boolean;
}

export interface AgentEvents {
  state: [agentId: string, projectId: string, status: AgentStatus];
  item: [agentId: string, item: StoredItem];
  /** The transcript was rebuilt from scratch; clients must refetch items. */
  reset: [agentId: string];
  session: [agentId: string, session: AgentSessionRef];
  counts: [projectId: string, counts: AgentCounts];
}

export const LABEL_PREFIX = 'agent-manager:';
const STARTING_GRACE_MS = 5000;
const LOCK_PATIENCE_MS = 2000;

const toAgent = (r: AgentRow): Agent => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  profile: r.profile,
  cwd: r.cwd,
  vendorConversationId: r.vendor_conversation_id,
  permissions: r.permissions === 'ask' ? 'ask' : 'bypass',
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

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

const busy = () =>
  new HttpException(
    { statusCode: 409, message: 'a turn is in progress', code: 'agent-busy' },
    409,
  );
const unavailable = (why: string) =>
  new HttpException(
    {
      statusCode: 503,
      message: `agent unavailable: ${why}`,
      code: 'agent-unavailable',
    },
    503,
  );
const asHttp = (err: unknown): unknown =>
  err instanceof DaemonError ? unavailable(err.message) : err;

/**
 * Agents: definitions in SQLite, everything live rebuilt from the daemon.
 * Each daemon session has its own adapter and cursor; records flow through
 * them into items and state. Commands and rebuilds are serialised per
 * agent, every command re-reads the agent row under the lock, and commands
 * wait for a pending resync. Attachments live on the daemon socket, so a
 * disconnect invalidates every session until it is re-attached; an exit
 * for a session whose log has not been replayed yet is held until it has.
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
  /** projects being deleted; creates and turns are refused meanwhile */
  private readonly deleting = new Set<string>();
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
    this.daemon.on('disconnected', () => this.onDaemonLost());
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

  private find(id: string): Agent | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as
      AgentRow | undefined;
    return row ? toAgent(row) : null;
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
    input: {
      name?: unknown;
      profile?: unknown;
      cwd?: unknown;
      permissions?: unknown;
    },
  ): Promise<{ agent: Agent; status: AgentStatus }> {
    const project = this.projects.get(projectId);
    if (this.deleting.has(projectId))
      throw new ConflictException('project is being deleted');
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
    const permissions: Permissions =
      input.permissions === undefined
        ? 'bypass'
        : (input.permissions as Permissions);
    if (permissions !== 'bypass' && permissions !== 'ask')
      throw new BadRequestException('"permissions" must be "bypass" or "ask"');
    // cwd is one of the project's repos, by name or absolute path; default the primary.
    const cwd = input.cwd
      ? this.projects.repoOf(project, input.cwd as string)?.path
      : project.path;
    if (!cwd)
      throw new BadRequestException(
        `"cwd" must name one of the project's repos: ${project.repos.map((r) => r.name).join(', ')}`,
      );
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
      permissions,
    };
    this.db
      .prepare(
        'INSERT INTO agents (id, project_id, name, profile, cwd, created_at, permissions) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        agent.id,
        projectId,
        agent.name,
        profile,
        cwd,
        agent.createdAt,
        permissions,
      );
    const live = this.ensureLive(agent);
    try {
      await this.withLock(live, () => this.startSession(agent, live));
    } catch (err) {
      if (err instanceof DaemonError && err.code === 'disconnected') {
        // The daemon may well have started the process; the recorded
        // session id lets the next resync find out and adopt or forget it.
        throw asHttp(err);
      }
      // No process, no agent: leave nothing behind for the user to wonder about.
      this.db.prepare('DELETE FROM agents WHERE id = ?').run(agent.id);
      this.live.delete(agent.id);
      throw asHttp(err);
    }
    return { agent: this.get(agent.id), status: live.status };
  }

  /**
   * Sends a user turn. Waits for a pending resync, refuses while a turn is
   * in progress (`agent-busy`) and while the current session's output is
   * not attached (`agent-unavailable`). Starts or resumes a session first
   * if none is live.
   */
  async turn(id: string, text: unknown, userId?: string): Promise<void> {
    if (typeof text !== 'string' || text.length === 0)
      throw new BadRequestException('"text" is required');
    const live = this.ensureLive(this.get(id));
    await live.synced;
    await this.withLock(live, async () => {
      let agent = this.get(id);
      if (agent.archivedAt) throw new ConflictException('agent is archived');
      if (this.deleting.has(agent.projectId))
        throw new ConflictException('project is being deleted');
      if (!agent.currentSessionId) {
        await this.startSession(agent, live);
        agent = this.get(id);
      }
      const attached = live.sessions.get(agent.currentSessionId!);
      if (!attached) throw unavailable('session not tracked');
      if (!attached.replayed) {
        // Never accept input for output we cannot see, and never judge
        // busy on state that predates a lost link: catch up first.
        await this.attachSession(agent, live, attached);
        if (!attached.replayed)
          throw unavailable('the session log could not be read');
        this.reconcileTurnState(agent, live, attached);
        agent = this.get(id);
        if (!agent.currentSessionId)
          throw unavailable(
            'the session had ended; send the turn again to resume',
          );
      }
      await this.awaitStarting(live);
      if (
        live.status.state === 'working' ||
        live.status.state === 'starting' ||
        live.status.state === 'waiting-permission'
      )
        throw busy();
      const sl = live.sessions.get(agent.currentSessionId!);
      if (!sl) throw unavailable('session not tracked');
      // Working from the moment we commit to sending; the logged input
      // confirms it and a fast result may already move on to idle.
      const before = live.status;
      this.setState(agent, live, 'working', null);
      // The author is matched to the input record when it comes back from
      // the daemon (turns are sent one at a time, so order suffices) and
      // stored by session and seq, which is what a rebuild has.
      if (userId) live.pendingAuthors.push(userId);
      try {
        for (const line of sl.adapter.turn(text))
          await this.daemon.input(agent.currentSessionId!, line);
      } catch (err) {
        if (userId) live.pendingAuthors.pop();
        // A request lost in flight may still have been delivered; the resync
        // reconciles that from the log. Only a certain refusal reverts.
        const uncertain =
          err instanceof DaemonError && err.code === 'disconnected';
        if (!uncertain && (live.status as AgentStatus).state === 'working')
          this.setState(agent, live, before.state, before.error);
        throw asHttp(err);
      }
    });
  }

  /** Answers a pending permission request with one of its options; the adapter knows which are pending from the log. */
  async decide(id: string, requestId: unknown, option: unknown): Promise<void> {
    if (typeof requestId !== 'string' || typeof option !== 'string')
      throw new BadRequestException('"requestId" and "option" are required');
    const live = this.ensureLive(this.get(id));
    const agent = this.get(id);
    await live.synced;
    const sl = agent.currentSessionId
      ? live.sessions.get(agent.currentSessionId)
      : undefined;
    const lines = sl?.adapter.decide?.(requestId, option);
    if (!lines)
      throw new NotFoundException(
        'no such pending permission request (or no such option)',
      );
    try {
      for (const line of lines)
        await this.daemon.input(agent.currentSessionId!, line);
    } catch (err) {
      throw asHttp(err);
    }
  }

  async interrupt(id: string): Promise<void> {
    const live = this.ensureLive(this.get(id));
    const agent = this.get(id);
    const sl = agent.currentSessionId
      ? live.sessions.get(agent.currentSessionId)
      : undefined;
    if (!sl?.adapter.interrupt)
      throw new ConflictException('nothing to interrupt');
    // Deliberately outside the lock: an interrupt must reach a turn that is blocked on stdin.
    try {
      for (const line of sl.adapter.interrupt())
        await this.daemon.input(agent.currentSessionId!, line);
    } catch (err) {
      throw asHttp(err);
    }
  }

  /** Ends the current session politely; the agent stays resumable. */
  async stop(id: string): Promise<void> {
    const live = this.ensureLive(this.get(id));
    await this.withLockOrForce(live, id, () => this.stopLocked(this.get(id)));
  }

  async archive(id: string): Promise<void> {
    const live = this.ensureLive(this.get(id));
    await this.withLockOrForce(live, id, async () => {
      const agent = this.get(id);
      await this.stopLocked(agent, true);
      this.db
        .prepare('UPDATE agents SET archived_at = ? WHERE id = ?')
        .run(Date.now(), id);
      this.emit('counts', agent.projectId, this.counts(agent.projectId));
    });
  }

  /**
   * Stops every agent of a project and forgets it; called before the
   * project row is deleted. The project is fenced against new agents and
   * turns for the duration, and the caller keeps the fence until the row
   * is gone (`releaseProject`).
   */
  async removeProject(projectId: string): Promise<void> {
    this.deleting.add(projectId);
    try {
      for (;;) {
        const row = this.db
          .prepare(
            'SELECT * FROM agents WHERE project_id = ? ORDER BY created_at LIMIT 1',
          )
          .get(projectId) as AgentRow | undefined;
        if (!row) return;
        const live = this.ensureLive(toAgent(row));
        await this.withLockOrForce(live, row.id, async () => {
          const agent = this.get(row.id); // fresh: a resume may have happened while we waited
          await this.stopLocked(agent, true);
          for (const sid of live.sessions.keys()) this.sessionOwner.delete(sid);
          this.live.delete(agent.id);
          this.db.prepare('DELETE FROM agents WHERE id = ?').run(agent.id);
        });
      }
    } catch (err) {
      this.deleting.delete(projectId);
      throw asHttp(err);
    }
  }

  releaseProject(projectId: string): void {
    this.deleting.delete(projectId);
  }

  /**
   * Ends the current session: close stdin, and when `wait` is set, escalate
   * to SIGTERM and SIGKILL if the process lingers, so the caller can rely on
   * it being gone. Losing the daemon meanwhile is an error, not an exit.
   */
  private async stopLocked(agent: Agent, wait = false): Promise<void> {
    const liveAgent = this.ensureLive(agent);
    if (!agent.currentSessionId && liveAgent.adoptionNeeded) {
      // The resync has not reached this agent yet; an empty pointer proves
      // nothing until adoption has had its say.
      this.adoptSessions(agent, await this.daemon.listSessions());
      liveAgent.adoptionNeeded = false;
    }
    const id = agent.currentSessionId;
    if (!id) return;
    try {
      await this.daemon.endInput(id);
    } catch (err) {
      if (!(err instanceof DaemonError)) throw err;
      if (err.code === 'disconnected' || err.code === 'not-connected')
        throw unavailable(err.message);
      if (err.code !== 'unknown-session') {
        try {
          await this.daemon.signal(id, 'SIGTERM');
        } catch (e2) {
          if (
            !(e2 instanceof DaemonError) ||
            (e2.code !== 'unknown-session' && e2.code !== 'session-not-running')
          )
            throw asHttp(e2);
        }
      }
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
        try {
          const s = await this.daemon.getSession(id);
          if (s.state === 'exited') return;
        } catch (err) {
          if (err instanceof DaemonError && err.code === 'unknown-session')
            return;
          throw asHttp(err);
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    throw unavailable('the process did not exit');
  }

  // ---- sessions -----------------------------------------------------------

  /** Starts a new daemon session for the agent. Ownership is registered before any output is consumed. */
  private async startSession(agent: Agent, live: Live): Promise<void> {
    const adapter = this.adapters.create(agent.profile);
    // The session id is ours and recorded first: if the reply is lost, the
    // next resync can still tell whether the process exists.
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO agent_sessions (daemon_session_id, agent_id, started_at) VALUES (?, ?, ?)',
      )
      .run(id, agent.id, Date.now());
    this.db
      .prepare('UPDATE agents SET current_session_id = ? WHERE id = ?')
      .run(id, agent.id);
    agent.currentSessionId = id;
    let session: DaemonSession;
    try {
      session = await this.daemon.start({
        id,
        profile: agent.profile,
        args: adapter.startArgs({
          resume: agent.vendorConversationId,
          extraDirs: this.extraDirs(agent),
          permissions: agent.permissions,
        }),
        cwd: agent.cwd,
        label: `${LABEL_PREFIX}${agent.id}`,
      });
    } catch (err) {
      if (err instanceof DaemonError && err.code === 'disconnected') {
        this.setState(agent, live, 'exited', null); // until the resync says otherwise
        throw err;
      }
      // Refused outright: nothing was started.
      this.db
        .prepare('DELETE FROM agent_sessions WHERE daemon_session_id = ?')
        .run(id);
      this.db
        .prepare(
          'UPDATE agents SET current_session_id = NULL WHERE id = ? AND current_session_id = ?',
        )
        .run(agent.id, id);
      agent.currentSessionId = null;
      throw err;
    }
    const sl = this.trackSession(agent, live, session.id, adapter);
    this.appendItem(agent.id, live, session.id, 0, {
      kind: 'system',
      text: agent.vendorConversationId
        ? `session resumed (${session.id})`
        : `session started (${session.id})`,
    });
    sl.startedBoundary = true;
    this.setState(agent, live, adapter.initialState ?? 'starting', null);
    this.emit('session', agent.id, {
      daemonSessionId: session.id,
      startedAt: session.startedAt,
      endedAt: null,
    });
    // Attach with replay from the start: anything the process said (or an
    // exit) between start and now is in the log.
    await this.attachSession(agent, live, sl);
    if (adapter.startLines)
      this.sendLines(
        agent,
        sl,
        adapter.startLines({
          cwd: agent.cwd,
          resume: agent.vendorConversationId,
          permissions: agent.permissions,
        }),
      );
    await this.reconcileCurrent(agent, live);
  }

  /** The project's other repositories, for agents that need to be told about them. */
  private extraDirs(agent: Agent): string[] {
    try {
      return this.projects
        .get(agent.projectId)
        .repos.map((r) => r.path)
        .filter((p) => p !== agent.cwd);
    } catch {
      return [];
    }
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
        complete: false,
        attaching: false,
        pendingExit: null,
        pendingBoundary: null,
        suspended: false,
        startedBoundary: false,
        endedBoundary: false,
        keys: new Map(),
        pendingSends: [],
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
    sl.suspended = false;
    let boundary = Number.MAX_SAFE_INTEGER;
    try {
      boundary = await this.daemon.attach(sl.id, sl.lastSeq + 1);
      sl.replayed = true;
      sl.complete = true;
    } catch (err) {
      sl.replayed = false;
      sl.complete = false; // the tail past the cursor is not ours yet
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
    // Handshake replies that arrived during the attach: only those past the
    // daemon's boundary at attach time are live; the rest are history.
    const queued = sl.pendingSends.splice(0);
    for (const q of queued)
      if (q.seq > boundary) this.sendLines(agent, sl, q.lines);
    if (sl.pendingExit && sl.replayed) {
      const s = sl.pendingExit;
      sl.pendingExit = null;
      this.applyExit(agent, live, s);
    }
    if (sl.pendingBoundary && sl.complete) {
      const s = sl.pendingBoundary;
      sl.pendingBoundary = null;
      this.endBoundary(agent, live, sl, s);
    }
    this.releaseState(agent, live);
  }

  /** Writes adapter-produced lines to a live, current session; failures are logged, the record path continues. */
  private sendLines(agent: Agent, sl: SessionLive, lines: unknown[]): void {
    if (!lines.length) return;
    const fresh = this.find(agent.id);
    if (!fresh || fresh.currentSessionId !== sl.id) return;
    void (async () => {
      for (const line of lines) await this.daemon.input(sl.id, line);
    })().catch((err: Error) =>
      this.logger.warn(
        `agent ${agent.id}: could not send protocol line: ${err.message}`,
      ),
    );
  }

  /** The "session ended" item, written once, and only after the session's records. */
  private endBoundary(
    agent: Agent,
    live: Live,
    sl: SessionLive,
    session: DaemonSession,
  ): void {
    if (sl.endedBoundary) return;
    if (!sl.complete || sl.attaching) {
      sl.pendingBoundary = session;
      return;
    }
    this.appendItem(agent.id, live, session.id, 0, {
      kind: 'system',
      text: `session ended${exitWhy(session)}`,
    });
    sl.endedBoundary = true;
  }

  /**
   * After catching up the current session: an optimistic `working` set
   * for a turn whose acknowledgement was lost is confirmed or dropped by
   * what the adapter actually saw in the log.
   */
  private reconcileTurnState(agent: Agent, live: Live, sl: SessionLive): void {
    const open = sl.adapter.turnInProgress?.();
    if (open === undefined) return;
    if (live.status.state === 'working' && !open)
      this.setState(agent, live, 'idle', null);
    if (live.status.state === 'idle' && open)
      this.setState(agent, live, 'working', null);
  }

  /** After attaching to the current session, make sure a session that already died is treated as such. */
  private async reconcileCurrent(agent: Agent, live: Live): Promise<void> {
    const fresh = this.find(agent.id);
    if (!fresh?.currentSessionId) return;
    agent.currentSessionId = fresh.currentSessionId;
    try {
      const s = await this.daemon.getSession(fresh.currentSessionId);
      if (s.state === 'exited') this.applyExit(agent, live, s);
    } catch (err) {
      if (err instanceof DaemonError && err.code === 'unknown-session') {
        this.applyExit(agent, live, {
          id: fresh.currentSessionId,
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
    if (!live || !sl || sl.suspended) return;
    if (record.seq <= sl.lastSeq) return; // overlap after a reconnect
    sl.lastSeq = record.seq;
    const agent = this.find(agentId);
    if (!agent) return;
    this.apply(agent, live, sl, record, sl.adapter.ingest(record));
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
    if (ingest.send?.length) {
      if (sl.attaching)
        sl.pendingSends.push({ seq: record.seq, lines: ingest.send });
      else this.sendLines(agent, sl, ingest.send);
    }
    // State from a session that is no longer current is history, not now;
    // state from a replay in flight is applied but announced only at its end.
    if (ingest.background !== undefined && sl.id === agent.currentSessionId)
      this.setBackground(agent, live, ingest.background, sl.attaching);
    if (ingest.state && sl.id === agent.currentSessionId)
      this.setState(
        agent,
        live,
        ingest.state,
        ingest.error ?? null,
        sl.attaching,
      );
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
    if (op.item.kind === 'user') this.attribute(live, sl, seq, op.item);
    const stored = this.appendItem(agentId, live, sl.id, seq, op.item);
    if (op.key) sl.keys.set(op.key, stored.index);
  }

  /**
   * Names the sender of a user turn. A recorded author (session, seq) wins;
   * otherwise a live turn takes the next pending author and records it.
   * Replayed history with no record stays unattributed.
   */
  private attribute(
    live: Live,
    sl: SessionLive,
    seq: number,
    item: Extract<Item, { kind: 'user' }>,
  ): void {
    let row = this.db
      .prepare(
        'SELECT u.name FROM turn_authors a JOIN users u ON u.id = a.user_id WHERE a.daemon_session_id = ? AND a.seq = ?',
      )
      .get(sl.id, seq) as { name: string } | undefined;
    if (!row && !sl.attaching && live.pendingAuthors.length) {
      const userId = live.pendingAuthors.shift()!;
      this.db
        .prepare(
          'INSERT OR IGNORE INTO turn_authors (daemon_session_id, seq, user_id) VALUES (?, ?, ?)',
        )
        .run(sl.id, seq, userId);
      row = this.db
        .prepare('SELECT name FROM users WHERE id = ?')
        .get(userId) as { name: string } | undefined;
    }
    if (row) item.by = row.name;
  }

  private onSessionChanged(session: DaemonSession): void {
    if (session.state !== 'exited') return;
    const agentId =
      this.sessionOwner.get(session.id) ??
      (session.label?.startsWith(LABEL_PREFIX)
        ? session.label.slice(LABEL_PREFIX.length)
        : undefined);
    if (!agentId) return;
    const agent = this.find(agentId);
    if (!agent) return;
    const live = this.ensureLive(agent);
    const sl =
      live.sessions.get(session.id) ??
      this.trackSession(
        agent,
        live,
        session.id,
        this.adapters.create(agent.profile),
      );
    if (sl.attaching || !sl.replayed) {
      // The boundary goes after the records: wait for this session's replay
      // (in flight, or coming with the next resync after a restart).
      sl.pendingExit = session;
      return;
    }
    this.applyExit(agent, live, session);
  }

  /**
   * Records a session's exit. The current pointer is cleared only if it
   * still points at this session (a resume may have moved it), which is
   * decided by the database, not by a possibly stale in-memory row.
   */
  private applyExit(agent: Agent, live: Live, session: DaemonSession): void {
    this.db
      .prepare(
        'UPDATE agent_sessions SET ended_at = ? WHERE daemon_session_id = ? AND ended_at IS NULL',
      )
      .run(session.exitedAt ?? Date.now(), session.id);
    const cleared = this.db
      .prepare(
        'UPDATE agents SET current_session_id = NULL WHERE id = ? AND current_session_id = ?',
      )
      .run(agent.id, session.id).changes;
    if (cleared === 0) return;
    agent.currentSessionId = null;
    const sl =
      live.sessions.get(session.id) ??
      this.trackSession(
        agent,
        live,
        session.id,
        this.adapters.create(agent.profile),
      );
    this.endBoundary(agent, live, sl, session);
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
    // Every known agent waits for this resync before accepting commands.
    for (const { id } of this.db.prepare('SELECT id FROM agents').all() as {
      id: string;
    }[]) {
      const agent = this.find(id);
      if (agent) this.gate(this.ensureLive(agent));
    }
    this.resyncChain = this.resyncChain
      .then(() => this.resync(generation))
      .catch((err: Error) => this.logger.error(`resync failed: ${err.message}`))
      .finally(() => {
        // Nobody stays gated behind a resync that is over, unless a newer
        // one has taken over and will release them itself.
        if (generation === this.resyncGeneration)
          for (const live of this.live.values()) live.markSynced();
      });
  }

  /** Opens the gate if it is not already open; waiters from before are kept. */
  private gate(live: Live): void {
    live.adoptionNeeded = true;
    if (live.syncPending) return;
    const d = deferred();
    live.syncPending = true;
    live.synced = d.promise;
    live.markSynced = () => {
      live.syncPending = false;
      d.resolve();
    };
  }

  /** The socket the attachments lived on is gone; every session must be re-attached before it is trusted. */
  private onDaemonLost(): void {
    for (const live of this.live.values()) {
      for (const sl of live.sessions.values()) sl.replayed = false;
      this.gate(live);
    }
  }

  /**
   * After (re)connecting to the daemon: bring every agent up to date with
   * its sessions. Runs one agent at a time under that agent's lock,
   * re-reading the agent row and the daemon's session records inside the
   * lock. A newer resync supersedes an older one.
   */
  private async resync(generation: number): Promise<void> {
    const ids = (
      this.db.prepare('SELECT id FROM agents').all() as { id: string }[]
    ).map((r) => r.id);
    let done = 0;
    for (const id of ids) {
      if (generation !== this.resyncGeneration) return;
      const stale = this.find(id);
      if (!stale) continue;
      const live = this.ensureLive(stale);
      await this.withLock(live, async () => {
        const agent = this.find(id);
        if (!agent || generation !== this.resyncGeneration) return;
        const sessions = await this.daemon.listSessions();
        const byId = new Map(sessions.map((s) => [s.id, s]));
        this.adoptSessions(agent, sessions);
        live.adoptionNeeded = false;
        let refs = this.sessions(agent.id);

        // An earlier session whose replay failed, with newer history already
        // shown after it: the only way to keep order is to start over.
        const failedEarlier = refs.some(
          (ref, i) =>
            i < refs.length - 1 &&
            live.sessions.get(ref.daemonSessionId)?.complete === false,
        );
        if (failedEarlier && live.items.length > 0) {
          this.logger.log(
            `agent ${agent.id}: rebuilding transcript so recovered history keeps its order`,
          );
          live.items = [];
          for (const sl of live.sessions.values()) {
            sl.lastSeq = 0;
            sl.replayed = false;
            sl.complete = false;
            sl.suspended = true; // live frames must not advance the cursor before the replay attach
            sl.startedBoundary = false;
            sl.endedBoundary = false;
            sl.keys.clear();
            sl.adapter = this.adapters.create(agent.profile);
          }
          this.emit('reset', agent.id);
        }
        refs = this.sessions(agent.id);
        for (const [i, ref] of refs.entries()) {
          if (generation !== this.resyncGeneration) return;
          const s = byId.get(ref.daemonSessionId);
          if (!s) continue;
          const sl = this.trackSession(
            agent,
            live,
            s.id,
            live.sessions.get(s.id)?.adapter ??
              this.adapters.create(agent.profile),
          );
          if (!sl.startedBoundary) {
            this.appendItem(agent.id, live, s.id, 0, {
              kind: 'system',
              text: `${i === 0 ? 'session started' : 'session resumed'} (${s.id})`,
            });
            sl.startedBoundary = true;
          }
          const isCurrent = s.id === agent.currentSessionId;
          if (
            isCurrent &&
            s.state === 'running' &&
            (live.status.state === 'starting' || live.status.state === 'exited')
          ) {
            this.setState(
              agent,
              live,
              sl.adapter.initialState ?? 'starting',
              null,
            );
          }
          // Catch up whenever the cursor trails the daemon, exited or not.
          if (
            !sl.replayed ||
            sl.lastSeq < s.lastSeq ||
            (isCurrent && s.state === 'running')
          ) {
            await this.attachSession(agent, live, sl);
            if (isCurrent && s.state === 'running' && sl.replayed)
              this.reconcileTurnState(agent, live, sl);
          }
          if (s.state === 'exited' && !sl.pendingExit) {
            if (isCurrent) this.applyExit(agent, live, s);
            else this.endBoundary(agent, live, sl, s);
            if (ref.endedAt === null)
              this.db
                .prepare(
                  'UPDATE agent_sessions SET ended_at = ? WHERE daemon_session_id = ?',
                )
                .run(s.exitedAt ?? Date.now(), s.id);
          }
        }
        await this.reconcileCurrent(agent, live);
        const fresh = this.find(agent.id);
        if (fresh && !fresh.currentSessionId && live.status.state !== 'exited')
          this.setState(agent, live, 'exited', null);
        live.markSynced();
      });
      done++;
    }
    this.logger.log(`resynced ${done} agent(s)`);
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
          .prepare(
            'UPDATE agents SET current_session_id = ? WHERE id = ? AND current_session_id IS NULL',
          )
          .run(current.id, agent.id);
        agent.currentSessionId = this.find(agent.id)?.currentSessionId ?? null;
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
          background: 0,
        },
        items: [],
        lock: Promise.resolve(),
        synced: Promise.resolve(),
        markSynced: () => undefined,
        syncPending: false,
        adoptionNeeded: true,
        stateHeld: false,
        pendingAuthors: [],
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

  /**
   * For stop-like commands: queue behind the lock first, so a turn arriving
   * meanwhile lands behind the stop. If the lock does not free up (a turn
   * blocked on a stdin write the agent is not reading), signal the process,
   * escalating to SIGKILL, so that write fails and the queue moves.
   */
  private async withLockOrForce<T>(
    live: Live,
    agentId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    // A pending resync may still adopt a session; give it a moment so an
    // empty current pointer is not mistaken for "nothing to stop".
    await Promise.race([
      live.synced,
      new Promise((r) => setTimeout(r, LOCK_PATIENCE_MS)),
    ]);
    let acquired = false;
    const run = this.withLock(live, () => {
      acquired = true;
      return fn();
    });
    const settled = run.then(
      () => true,
      () => true,
    );
    for (const [signal, wait] of [
      ['SIGTERM', LOCK_PATIENCE_MS],
      ['SIGKILL', LOCK_PATIENCE_MS + 1000],
    ] as const) {
      const free = await Promise.race([
        settled,
        new Promise<boolean>((r) => setTimeout(() => r(false), wait)),
      ]);
      if (free || acquired) break;
      const sid = this.find(agentId)?.currentSessionId;
      if (!sid) break;
      this.logger.warn(
        `agent ${agentId}: a command is blocked; sending ${signal} to free it`,
      );
      await this.daemon.signal(sid, signal).catch(() => undefined);
    }
    return run;
  }

  /** Gives a freshly started or resumed process a moment to report ready before a turn is judged. */
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

  /** Records the status; announces it unless `quiet` (a replay in flight), in which case `releaseState` will. */
  private setState(
    agent: Agent,
    live: Live,
    state: AgentState,
    error: string | null,
    quiet = false,
  ): void {
    if (live.status.state === state && live.status.error === error) return;
    live.status = {
      state,
      error,
      lastActivityAt: Date.now(),
      background: live.status.background,
    };
    if (quiet) {
      live.stateHeld = true;
      return;
    }
    live.stateHeld = false;
    this.emit('state', agent.id, agent.projectId, live.status);
    this.emit('counts', agent.projectId, this.counts(agent.projectId));
  }

  /** The count of background jobs is part of the status and announced like a state change. */
  private setBackground(
    agent: Agent,
    live: Live,
    background: number,
    quiet = false,
  ): void {
    if (live.status.background === background) return;
    live.status = { ...live.status, background, lastActivityAt: Date.now() };
    if (quiet) {
      live.stateHeld = true;
      return;
    }
    live.stateHeld = false;
    this.emit('state', agent.id, agent.projectId, live.status);
  }

  /** Announces a status that replay applied silently, once the replay is over. */
  private releaseState(agent: Agent, live: Live): void {
    if (!live.stateHeld) return;
    live.stateHeld = false;
    this.emit('state', agent.id, agent.projectId, live.status);
    this.emit('counts', agent.projectId, this.counts(agent.projectId));
  }
}
