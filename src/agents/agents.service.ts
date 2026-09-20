import path from 'node:path';
import fs from 'node:fs/promises';
import {
  BadRequestException,
  Inject,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  AccountUsage,
  Activity,
  ActivityKind,
  AgentAdapter,
  AgentState,
  Ingest,
  Item,
  ItemOp,
  Permissions,
  TurnImage,
} from '../adapters/adapter.js';
import { AdaptersService } from '../adapters/adapters.service.js';
import { HttpAdapterHost } from '@nestjs/core';
import { AuthService } from '../auth/auth.service.js';
import { loadHarnessTemplate, renderHarnessNote } from './harness.js';
import {
  type CachedSession,
  type CacheState,
  TranscriptCache,
  TRANSCRIPT_CACHE_VERSION,
} from './transcript-cache.js';
import {
  DaemonClient,
  DaemonError,
  DaemonSession,
  LogRecord,
} from '../daemon/daemon-client.js';
import { MANAGER_CONFIG } from '../config/config.js';
import type { ManagerConfig } from '../config/config.js';
import { DbService } from '../db/db.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { spendOnlyUsage } from './usage.js';

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
  /** Vendor model name to start sessions with; null is the vendor's default. */
  model: string | null;
  /** Vendor effort level to start sessions with; null is the vendor's default. */
  effort: string | null;
  /** What the agent was told about running here at its last session start; null when the note is off. */
  harnessNote: string | null;
  /** Who created it: a person's name, or `agent-<name>` for a helper started by another agent. */
  createdBy: string | null;
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
  /** The model the vendor reports as active in the current session, once it has said. */
  model: string | null;
  /** Messages held for the next turn because the vendor could not take one mid-turn. */
  queued: number;
  /** The vendor account's limits as last reported through this agent, if it has said. */
  usage: AccountUsage | null;
  /** What the last thing on the stream was doing; null outside a turn. */
  activity: Activity;
}

export interface StoredItem {
  index: number;
  sessionId: string;
  /** Daemon record range the item was built from; 0 for synthetic boundary items. */
  seqFrom: number;
  seqTo: number;
  /** When the item first appeared, unix ms (the daemon record's time). */
  at: number;
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
  model: string | null;
  effort: string | null;
  harness_note: string | null;
  created_by: string | null;
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
  /** The last point at which everything of this session so far was final and cacheable. */
  settled: CachedSession | null;
  /** Tracked from the cache header, not from the daemon; checked against the daemon on resync. */
  fromCache: boolean;
  /** The usage this session last reported, as the vendor gave it (no total). */
  usage: AccountUsage | null;
}

/** Everything about an agent that is rebuilt from the daemon, never stored. */
interface Live {
  sessions: Map<string, SessionLive>;
  status: AgentStatus;
  /** The resident tail of the transcript; older items are read from the cache. */
  items: StoredItem[];
  /** Agent-wide index of `items[0]`. */
  itemBase: number;
  cache: {
    /** Items handed to the writer so far (also the index of the next item to hand it). */
    claimed: number;
    /** What is actually on disk; touched only by the write chain. */
    written: CacheState;
    /** Writes in order; each also evicts what it made safe to drop. */
    chain: Promise<void>;
    /** The header has been read (or found absent) since the process started. */
    loaded: boolean;
    /** A write failed: nothing is evicted and nothing more is written until a rebuild. */
    broken: boolean;
    /** Bumped by a rebuild, so writes and reads started against the old file stand down. */
    generation: number;
  };
  /** Per session, the settled point last written to the header, to notice a header-only change. */
  cacheHeaders: Map<string, CachedSession>;
  /** The daemon has been consulted about this agent since the process started. */
  loaded: boolean;
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
  /** Messages sent while a turn ran that the vendor could not take then; sent as turns when idle, to the session they were held for. In memory only. */
  queued: {
    text: string;
    userId?: string;
    images: TurnImage[];
    sessionId: string;
  }[];
  /** A queued message is being sent; no second flush until it is done. */
  flushing: boolean;
  /** When the watchdog last asked about background jobs. */
  lastPokeAt: number;
  /** When an `activity`-only change was last announced, for its own throttle. */
  lastActivityEmitAt: number;
  /** A coalesced `activity` change waiting out the throttle window; picks up the latest value when it fires. */
  activityFlush: NodeJS.Timeout | null;
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
  /** A new agent was created; clients add it to the active list. */
  created: [agent: Agent, status: AgentStatus];
  /** The agent was archived: off the active list but still readable; clients drop it from the active list. */
  archived: [agentId: string, projectId: string];
  /** The agent was forgotten for good; clients drop it. */
  removed: [agentId: string, projectId: string];
}

export const LABEL_PREFIX = 'agent-manager:';
/**
 * The author of a turn the manager sent by itself (the background poke).
 * Recorded like any other author, so the transcript says who asked and a
 * replay keeps it; it is not a user, so it never joins `users`.
 */
export const MANAGER_AUTHOR = 'manager';
/** How long a command waits for a resync in progress before giving up. */
const SYNC_WAIT_MS = 10_000;
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
  model: r.model ?? null,
  effort: r.effort ?? null,
  harnessNote: r.harness_note ?? null,
  createdBy: r.created_by ?? null,
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
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AgentsService.name);
  private readonly live = new Map<string, Live>();
  /** daemon session id -> agent id, for routing output */
  private readonly sessionOwner = new Map<string, string>();
  /** projects being deleted; creates and turns are refused meanwhile */
  private readonly deleting = new Set<string>();
  private resyncChain: Promise<void> = Promise.resolve();
  private watchdog: NodeJS.Timeout | null = null;
  private resyncGeneration = 0;
  private readonly cache: TranscriptCache;
  /** Per vendor profile, the usage last reported through any agent: the account on this machine. */
  private readonly latestUsage = new Map<
    string,
    { profile: string; agentId: string; usage: AccountUsage }
  >();

  constructor(
    @Inject(MANAGER_CONFIG) private readonly config: ManagerConfig,
    private readonly dbs: DbService,
    private readonly daemon: DaemonClient,
    private readonly adapters: AdaptersService,
    private readonly projects: ProjectsService,
    private readonly auth: AuthService,
    private readonly http: HttpAdapterHost,
  ) {
    super();
    this.cache = new TranscriptCache(config.dataDir);
  }

  private get db() {
    return this.dbs.db;
  }

  /**
   * An agent idle with background jobs for a long time may be waiting on
   * something that died without saying so. Every minute, any agent idle
   * with jobs pending and no activity for `backgroundPokeMs` gets a short
   * turn asking it to check on them, at most once per interval.
   */
  private startWatchdog(): void {
    // A minute is the right cadence for the half-hour default; a test that
    // shortens the interval needs the check to keep up with it.
    const every = Math.max(
      1000,
      Math.min(60_000, (this.config.backgroundPokeMs || 60_000) / 2),
    );
    this.watchdog = setInterval(() => void this.pokeStalled(), every);
    this.watchdog.unref();
  }

  private async pokeStalled(): Promise<void> {
    const limit = this.config.backgroundPokeMs;
    if (!limit || !this.daemon.connected) return;
    const now = Date.now();
    for (const [id, live] of this.live) {
      const st = live.status;
      if (st.state !== 'idle' || !st.background) continue;
      if (now - st.lastActivityAt < limit) continue;
      if (live.lastPokeAt && now - live.lastPokeAt < limit) continue;
      live.lastPokeAt = now;
      const minutes = Math.round((now - st.lastActivityAt) / 60_000);
      const jobs = `${st.background} background job${st.background === 1 ? '' : 's'}`;
      this.logger.log(`poking agent ${id}: ${jobs} pending for ${minutes} min`);
      try {
        await this.turn(
          id,
          `You have had ${jobs} pending for ${minutes} minutes with no news. Check whether they are still running; if one has finished or died, act on it or report it. If all is well and still running, say so briefly.`,
          MANAGER_AUTHOR, // the transcript says the manager asked, not a person
        );
      } catch (err) {
        this.logger.warn(
          `poke of agent ${id} failed: ${(err as Error).message}`,
        );
      }
    }
  }

  onModuleDestroy(): void {
    if (this.watchdog) clearInterval(this.watchdog);
  }

  onModuleInit(): void {
    this.startWatchdog();
    this.daemon.on('output', (id, record) => this.onOutput(id, record));
    this.daemon.on('changed', (session) => this.onSessionChanged(session));
    this.daemon.on('connected', () => this.scheduleResync());
    this.daemon.on('disconnected', () => this.onDaemonLost());
  }

  // ---- queries ------------------------------------------------------------

  list(
    projectId: string,
    archived = false,
  ): { agent: Agent; status: AgentStatus }[] {
    this.projects.get(projectId);
    return (
      this.db
        .prepare(
          `SELECT * FROM agents WHERE project_id = ? AND archived_at IS ${archived ? 'NOT NULL' : 'NULL'} ORDER BY ${archived ? 'archived_at DESC' : 'created_at'}`,
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

  /** How many transcript items the agent has produced so far; the index the next one gets. */
  itemCount(id: string): number {
    const live = this.ensureLive(this.get(id));
    return live.itemBase + live.items.length;
  }

  /**
   * Called with an agent's id before it is forgotten, while its rows and
   * its transcript are still there. Awaited, so what wants a copy of
   * something (the run log's transcript export) gets one; a hook rather
   * than a dependency, since the agent knows nothing of what watches it.
   */
  private beforeRemove: ((agentId: string) => Promise<void>)[] = [];

  onBeforeRemove(fn: (agentId: string) => Promise<void>): void {
    this.beforeRemove.push(fn);
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

  /**
   * Transcript items by index: everything from `from`, the last `tail`, or
   * `limit` items before `before`. Indexes are stable across the resident
   * tail and the cache. An archived agent is loaded on first access.
   */
  async items(
    id: string,
    query: { from?: number; tail?: number; before?: number; limit?: number },
  ): Promise<{ items: StoredItem[]; total: number }> {
    const agent = this.get(id);
    const live = this.ensureLive(agent);
    if (agent.archivedAt && !live.loaded) await this.loadArchived(id, live);
    const total = live.itemBase + live.items.length;
    let from = 0;
    let to = total;
    // (from, to) are fixed by the query; total may move while we read
    if (query.before !== undefined) {
      to = Math.min(query.before, total);
      from = Math.max(0, to - (query.limit ?? this.config.residentItems));
    } else if (query.tail !== undefined) {
      from = Math.max(0, total - query.tail);
    } else from = query.from ?? 0;
    if (from >= to) return { items: [], total };
    // The resident part is taken now; the cached part is read afterwards.
    // A rebuild meanwhile replaces the file: read again from scratch.
    for (let attempt = 0; ; attempt++) {
      const gen = live.cache.generation;
      const total = live.itemBase + live.items.length;
      const base = live.itemBase;
      const upTo = Math.min(to, total);
      const resident =
        upTo > base
          ? live.items.slice(Math.max(from, base) - base, upTo - base)
          : [];
      let cached: StoredItem[] = [];
      try {
        if (from < base)
          cached = await this.cache.read(
            id,
            live.cache.written,
            from,
            Math.min(upTo, base),
          );
      } catch (err) {
        if (gen === live.cache.generation || attempt >= 3) throw err;
      }
      if (gen === live.cache.generation || attempt >= 3)
        return { items: [...cached, ...resident], total };
    }
  }

  /** Brings an archived agent's transcript in (from the cache, and the daemon for what the cache lacks) once per process. */
  private async loadArchived(id: string, live: Live): Promise<void> {
    await this.withLock(live, async () => {
      if (live.loaded) return;
      const agent = this.find(id);
      if (!agent) return;
      await this.loadCache(agent, live); // what the cache has is served even with the daemon down
      if (!this.daemon.connected) return;
      try {
        await this.resyncAgent(id, this.resyncGeneration, live);
      } catch (err) {
        this.logger.warn(
          `agent ${id}: could not load archived transcript: ${(err as Error).message}`,
        );
      }
      // Loaded now, complete or not: a failed replay is tried again once
      // the daemon reconnects (scheduleResync), not on every request.
      live.loaded = true;
    });
  }

  /**
   * The report with the agent's total spend added: every restart starts the
   * vendor's counters from zero, so the earlier sessions' final spend is
   * added to this session's. Sessions the daemon no longer has are gone
   * from the sum too.
   */
  private withTotal(
    live: Live,
    sl: SessionLive,
    usage: AccountUsage,
  ): AccountUsage {
    if (!usage.spend) return usage;
    const total = { ...usage.spend };
    let priced = usage.spend.costUsd !== undefined;
    let others = 0;
    for (const other of live.sessions.values()) {
      if (other.id === sl.id || !other.usage?.spend) continue;
      others++;
      total.inputTokens += other.usage.spend.inputTokens;
      total.outputTokens += other.usage.spend.outputTokens;
      total.turns += other.usage.spend.turns;
      if (other.usage.spend.costUsd !== undefined) {
        total.costUsd = (total.costUsd ?? 0) + other.usage.spend.costUsd;
        priced = true;
      }
    }
    if (!priced) delete total.costUsd;
    return others ? { ...usage, total } : usage;
  }

  /** The account's latest report wins, by the report's own time: an older one replayed later does not. */
  private noteUsage(agent: Agent, usage: AccountUsage): void {
    const have = this.latestUsage.get(agent.profile);
    if (have && have.usage.at > usage.at) return;
    this.latestUsage.set(agent.profile, {
      profile: agent.profile,
      agentId: agent.id,
      usage,
    });
  }

  /** The vendor accounts' usage on this machine, one entry per profile that has reported. */
  usage(): { profile: string; agentId: string; usage: AccountUsage }[] {
    return [...this.latestUsage.values()].sort((a, b) =>
      a.profile.localeCompare(b.profile),
    );
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
      model?: unknown;
      effort?: unknown;
    },
    createdBy: string | null = null,
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
    const setting = (v: unknown, what: string): string | null => {
      if (v === undefined || v === null || v === '') return null;
      if (
        typeof v !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$/.test(v)
      )
        throw new BadRequestException(`"${what}" must be a short vendor name`);
      return v;
    };
    const model = setting(input.model, 'model');
    const effort = setting(input.effort, 'effort');
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
      model,
      effort,
      harnessNote: null, // set when the session starts
      createdBy,
    };
    this.db
      .prepare(
        'INSERT INTO agents (id, project_id, name, profile, cwd, created_at, permissions, model, effort, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        agent.id,
        projectId,
        agent.name,
        profile,
        cwd,
        agent.createdAt,
        permissions,
        model,
        effort,
        createdBy,
      );
    const live = this.ensureLive(agent);
    live.cache.loaded = true; // nothing on disk for a new agent
    live.loaded = true;
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
    const fresh = this.get(agent.id);
    // startSession already emitted this agent's state, but for an id no
    // client has seen; `created` is what makes it appear in every open tab.
    this.emit('created', fresh, live.status);
    return { agent: fresh, status: live.status };
  }

  /**
   * Sends a user turn. Waits for a pending resync, refuses while a turn is
   * in progress (`agent-busy`) and while the current session's output is
   * not attached (`agent-unavailable`). Starts or resumes a session first
   * if none is live.
   */
  /**
   * Sends a turn. With `steer`, a turn already running is not a refusal:
   * the message goes to the agent mid-turn where the vendor can take one
   * (Claude, Codex once the turn id is known) and is queued for the next
   * turn otherwise. Returns how it went.
   */
  async turn(
    id: string,
    text: unknown,
    userId?: string,
    opts: { steer?: boolean; forSession?: string; images?: unknown } = {},
  ): Promise<'sent' | 'steered' | 'queued' | 'dropped'> {
    if (typeof text !== 'string' || text.length === 0)
      throw new BadRequestException('"text" is required');
    const images = parseImages(opts.images);
    const live = this.ensureLive(this.get(id));
    await this.awaitSynced(live);
    return await this.withLock(live, async () => {
      let agent = this.get(id);
      if (agent.archivedAt) throw new ConflictException('agent is archived');
      if (this.deleting.has(agent.projectId))
        throw new ConflictException('project is being deleted');
      // A held message belongs to the session it was held for: it never
      // resumes an agent, and never reaches a session started since.
      if (opts.forSession && agent.currentSessionId !== opts.forSession)
        return 'dropped';
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
      const sl = live.sessions.get(agent.currentSessionId!);
      if (!sl) throw unavailable('session not tracked');
      const running =
        live.status.state === 'working' || sl.adapter.turnInProgress?.();
      if (
        running ||
        live.status.state === 'starting' ||
        live.status.state === 'waiting-permission'
      ) {
        if (
          !opts.steer ||
          !running ||
          live.status.state === 'waiting-permission'
        )
          throw busy();
        const lines = sl.adapter.steer?.(text, images) ?? [];
        if (lines.length === 0) {
          const heldBytes = live.queued.reduce(
            (n, q) => n + q.images.reduce((m, i) => m + i.data.length, 0),
            0,
          );
          if (
            live.queued.length >= QUEUE_LIMITS.messages ||
            heldBytes + images.reduce((m, i) => m + i.data.length, 0) >
              QUEUE_LIMITS.imageBytes
          )
            throw new HttpException(
              {
                statusCode: 409,
                code: 'agent-busy',
                message:
                  'too much is already held for this agent; wait for the turn to end',
              },
              409,
            );
          live.queued.push({
            text,
            userId,
            images,
            sessionId: agent.currentSessionId!,
          });
          live.status = { ...live.status, queued: live.queued.length };
          this.emit('state', agent.id, agent.projectId, live.status);
          return 'queued';
        }
        if (userId) live.pendingAuthors.push(userId);
        try {
          for (const line of lines)
            await this.daemon.input(agent.currentSessionId!, line);
        } catch (err) {
          const uncertain =
            err instanceof DaemonError && err.code === 'disconnected';
          if (userId && !uncertain) live.pendingAuthors.pop();
          throw asHttp(err);
        }
        return 'steered';
      }
      // Working from the moment we commit to sending; the logged input
      // confirms it and a fast result may already move on to idle.
      const lines = sl.adapter.turn(text, images);
      if (lines.length === 0)
        throw unavailable('the session is not ready for a turn yet');
      const before = live.status;
      this.setState(agent, live, 'working', null);
      // The author is matched to the input record when it comes back from
      // the daemon (turns are sent one at a time, so order suffices) and
      // stored by session and seq, which is what a rebuild has.
      if (userId) live.pendingAuthors.push(userId);
      try {
        for (const line of lines)
          await this.daemon.input(agent.currentSessionId!, line);
      } catch (err) {
        // A request lost in flight may still have been delivered; the resync
        // reconciles that from the log. Only a certain refusal reverts.
        const uncertain =
          err instanceof DaemonError && err.code === 'disconnected';
        if (userId && !uncertain) live.pendingAuthors.pop();
        if (!uncertain && (live.status as AgentStatus).state === 'working')
          this.setState(agent, live, before.state, before.error);
        throw asHttp(err);
      }
      return 'sent';
    });
  }

  /**
   * Sends the oldest queued message as a turn; one at a time, and only
   * while the session it was held for is still there. A busy refusal
   * keeps it for the next idle.
   */
  private async flushQueued(id: string): Promise<void> {
    const live = this.live.get(id);
    const agent = this.find(id);
    if (!live || !agent || !live.queued.length || live.flushing) return;
    if (!agent.currentSessionId) return this.dropQueued(agent, live);
    live.flushing = true;
    // The message stays at the head of the queue until it is sent, so a
    // refusal never has to put it back (and the queue's bound holds).
    const next = live.queued[0]!;
    let sent = false;
    try {
      const mode = await this.turn(id, next.text, next.userId, {
        forSession: next.sessionId,
        images: next.images,
      });
      sent = true;
      if (mode === 'dropped') this.dropQueued(agent, live);
    } catch (err) {
      const e = err as HttpException;
      // Busy again, or the daemon link down: not now, but still owed, as
      // long as the session it was held for is the current one.
      const later =
        e instanceof HttpException &&
        (e.getStatus() === 409 || e.getStatus() === 503);
      if (later && this.find(id)?.currentSessionId === next.sessionId) {
        live.flushing = false;
        return; // the next idle (after the reconnect's replay, if that was it) tries again
      }
      this.logger.warn(
        `agent ${id}: a queued message could not be sent and was dropped: ${(err as Error).message}`,
      );
      sent = true; // dropped: it leaves the queue all the same
    } finally {
      if (sent && live.queued[0] === next) {
        live.queued.shift();
        live.status = { ...live.status, queued: live.queued.length };
        this.emit('state', agent.id, agent.projectId, live.status);
      }
      live.flushing = false;
    }
    if (live.queued.length && live.status.state === 'idle')
      setImmediate(() => void this.flushQueued(id));
  }

  /** Forgets held messages (the session they were for is gone) and says so in the status. */
  private dropQueued(agent: Agent, live: Live): void {
    if (!live.queued.length && !live.status.queued) return;
    if (live.queued.length)
      this.logger.log(
        `agent ${agent.id}: ${live.queued.length} held message(s) dropped with the session`,
      );
    live.queued.length = 0;
    live.status = { ...live.status, queued: 0 };
    this.emit('state', agent.id, agent.projectId, live.status);
  }

  /**
   * Answers a pending permission request with one of its options. Under
   * the agent's lock and only on a replayed session, like a turn: the
   * adapter reserves the request when it builds the answer, so two people
   * clicking at once produce one answer and one refusal.
   */
  async decide(id: string, requestId: unknown, option: unknown): Promise<void> {
    if (typeof requestId !== 'string' || typeof option !== 'string')
      throw new BadRequestException('"requestId" and "option" are required');
    const live = this.ensureLive(this.get(id));
    await this.awaitSynced(live);
    await this.withLock(live, async () => {
      const agent = this.get(id);
      const sl = agent.currentSessionId
        ? live.sessions.get(agent.currentSessionId)
        : undefined;
      if (!sl) throw unavailable('session not tracked');
      if (!sl.replayed) {
        await this.attachSession(agent, live, sl);
        if (!sl.replayed)
          throw unavailable('the session log could not be read');
      }
      const lines = sl.adapter.decide?.(requestId, option);
      if (!lines)
        throw new NotFoundException(
          'no such pending permission request (or no such option)',
        );
      try {
        for (const line of lines)
          await this.daemon.input(agent.currentSessionId!, line);
      } catch (err) {
        // Refused for certain: the answer can be given again. A lost link
        // is uncertain; the replay that follows decides (afterReplay
        // releases what the log does not contain).
        if (!(err instanceof DaemonError && err.code === 'disconnected'))
          sl.adapter.afterReplay?.({
            cwd: agent.cwd,
            resume: agent.vendorConversationId,
            permissions: agent.permissions,
            note: agent.harnessNote,
          });
        throw asHttp(err);
      }
    });
  }

  async interrupt(id: string): Promise<void> {
    const live = this.ensureLive(this.get(id));
    await this.awaitSynced(live); // a fresh adapter mid-replay has no ids to interrupt with
    const agent = this.get(id);
    const sl = agent.currentSessionId
      ? live.sessions.get(agent.currentSessionId)
      : undefined;
    if (!sl?.adapter.interrupt)
      throw new ConflictException('nothing to interrupt');
    const lines = sl.adapter.interrupt();
    if (lines.length === 0)
      throw unavailable('the session is not ready to be interrupted yet');
    // Deliberately outside the lock: an interrupt must reach a turn that is blocked on stdin.
    try {
      for (const line of lines)
        await this.daemon.input(agent.currentSessionId!, line);
    } catch (err) {
      throw asHttp(err);
    }
  }

  /** Ends the current session politely; the agent stays resumable. */
  async stop(id: string): Promise<void> {
    const live = this.ensureLive(this.get(id));
    await this.withLockOrForce(live, id, async () => {
      const agent = this.get(id);
      this.dropQueued(agent, live); // a stop is the human's say: nothing held goes out after it
      await this.stopLocked(agent, true);
    });
  }

  /**
   * Stops and resumes one agent, so it starts a fresh process with the
   * current settings (repositories, harness note) and its conversation
   * intact. Refused while it works, waits on a permission or has
   * background jobs: the human interrupts first if that is meant. An
   * exited agent is simply started.
   */
  async restart(id: string): Promise<void> {
    const live = this.ensureLive(this.get(id));
    await this.awaitSynced(live);
    await this.withLock(live, async () => {
      const agent = this.get(id);
      if (agent.currentSessionId && live.status.state !== 'idle')
        throw new ConflictException(`agent is ${live.status.state}`);
      if (live.status.background > 0)
        throw new ConflictException('agent has background jobs');
      if (agent.currentSessionId) await this.stopLocked(agent, true);
      await this.startSession(this.get(id), live);
    });
  }

  /**
   * Stops and resumes every agent of a project that is idle with a live
   * session, so it picks up changed project settings (a repository added,
   * say). Agents mid-turn, waiting on a permission or with background
   * jobs are left alone and reported; exited ones need nothing, their
   * next turn starts afresh.
   */
  async restartIdle(
    projectId: string,
  ): Promise<{ restarted: string[]; skipped: { id: string; why: string }[] }> {
    const restarted: string[] = [];
    const skipped: { id: string; why: string }[] = [];
    for (const { agent } of this.list(projectId)) {
      const live = this.ensureLive(agent);
      await this.awaitSynced(live);
      await this.withLock(live, async () => {
        const fresh = this.get(agent.id);
        if (!fresh.currentSessionId) return;
        if (live.status.state !== 'idle') {
          skipped.push({ id: agent.id, why: live.status.state });
          return;
        }
        if (live.status.background > 0) {
          skipped.push({ id: agent.id, why: 'background jobs' });
          return;
        }
        await this.stopLocked(fresh, true);
        await this.startSession(this.get(agent.id), live);
        restarted.push(agent.id);
      });
    }
    return { restarted, skipped };
  }

  async archive(id: string): Promise<void> {
    const live = this.ensureLive(this.get(id));
    await this.withLockOrForce(live, id, async () => {
      const agent = this.get(id);
      await this.stopLocked(agent, true);
      // while the transcript is still readable
      for (const fn of this.beforeRemove)
        await fn(id).catch((err: Error) =>
          this.logger.warn(`agent ${id}: before-remove hook: ${err.message}`),
        );
      this.auth.revokeAgentTokens(id);
      this.db
        .prepare('UPDATE agents SET archived_at = ? WHERE id = ?')
        .run(Date.now(), id);
      this.emit('archived', id, agent.projectId);
      this.emit('counts', agent.projectId, this.counts(agent.projectId));
    });
  }

  /**
   * Forgets an agent for good: the process is stopped, the daemon's logs
   * of its sessions are removed, the transcript cache and the rows go.
   * The vendor's own conversation store is left alone. For helpers whose
   * work is in the git history and the feature's report.
   */
  async remove(id: string): Promise<void> {
    const live = this.ensureLive(this.get(id));
    await this.withLockOrForce(live, id, async () => {
      const agent = this.get(id);
      await this.stopLocked(agent, true);
      // while the transcript is still readable
      for (const fn of this.beforeRemove)
        await fn(id).catch((err: Error) =>
          this.logger.warn(`agent ${id}: before-remove hook: ${err.message}`),
        );
      this.auth.revokeAgentTokens(id);
      const refs = this.sessions(id);
      this.db.prepare('DELETE FROM agents WHERE id = ?').run(id); // sessions and authors cascade
      if (live.activityFlush) clearTimeout(live.activityFlush);
      this.live.delete(id);
      for (const ref of refs) {
        this.sessionOwner.delete(ref.daemonSessionId);
        await this.daemon.remove(ref.daemonSessionId).catch((err: Error) => {
          this.logger.warn(
            `agent ${id}: daemon log of ${ref.daemonSessionId} not removed: ${err.message}`,
          );
        });
      }
      await this.cache.clear(id).catch(() => undefined);
      await fs
        .rm(path.join(this.config.dataDir, 'harness', id), {
          recursive: true,
          force: true,
        })
        .catch(() => undefined);
      this.emit('removed', id, agent.projectId);
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
          if (live.activityFlush) clearTimeout(live.activityFlush);
          this.live.delete(agent.id);
          this.db.prepare('DELETE FROM agents WHERE id = ?').run(agent.id);
          await live.cache.chain;
          await this.cache.clear(agent.id).catch(() => undefined);
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
    // its own way back in: `am` in the process reads these
    const token = this.auth.issueAgentToken(agent.id, agent.projectId);
    const own = {
      AGENT_MANAGER_URL: this.ownUrl(),
      AGENT_MANAGER_TOKEN: token,
    };
    const note = this.harnessNote(agent);
    this.db
      .prepare('UPDATE agents SET harness_note = ? WHERE id = ?')
      .run(note, agent.id);
    agent.harnessNote = note;
    let session: DaemonSession;
    try {
      session = await this.daemon.start({
        id,
        profile: agent.profile,
        args: adapter.startArgs({
          resume: agent.vendorConversationId,
          extraDirs: this.extraDirs(agent),
          permissions: agent.permissions,
          model: agent.model,
          effort: agent.effort,
          note,
        }),
        cwd: agent.cwd,
        env: { ...own, ...(await this.noteEnv(agent, adapter, note)) },
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
    // The attach's post-replay step sends the handshake (nothing is logged
    // yet, so the adapter owes all of it); adapters without one need none.
    await this.attachSession(agent, live, sl);
    if (!sl.replayed && adapter.startLines)
      this.sendLines(
        agent,
        sl,
        adapter.startLines({
          cwd: agent.cwd,
          resume: agent.vendorConversationId,
          permissions: agent.permissions,
          note: agent.harnessNote,
        }),
      );
    await this.reconcileCurrent(agent, live);
  }

  /** Where an agent on this machine reaches this manager: loopback and the port actually bound (configured 0 means ephemeral). */
  private ownUrl(): string {
    const addr = this.http.httpAdapter?.getHttpServer?.()?.address?.();
    const port =
      addr && typeof addr === 'object' && addr.port
        ? addr.port
        : this.config.port;
    return `http://127.0.0.1:${port}`;
  }

  /** The harness note for this agent, from the operator's template or the built-in one; null when turned off. */
  private harnessNote(agent: Agent): string | null {
    let repos: { name: string; path: string }[] = [];
    let project = agent.projectId;
    try {
      const p = this.projects.get(agent.projectId);
      repos = p.repos;
      project = p.name;
    } catch {
      /* deleted meanwhile: the note still says who the agent is */
    }
    return renderHarnessNote(
      loadHarnessTemplate(
        this.config.harnessFile,
        this.config.shippedHarnessFile,
      ),
      {
        agent: agent.name,
        project,
        host: this.config.hostName,
        profile: agent.profile,
        cwd: agent.cwd,
        permissions: agent.permissions,
        repos,
        startedBy: agent.createdBy,
        // the house view of the models, read the same way as the note
        // itself: at session start, so an edit reaches an agent at its
        // next restart and not before
        models: loadHarnessTemplate(
          this.config.modelsFile,
          this.config.shippedModelsFile,
        ),
      },
    );
  }

  /**
   * For a vendor that reads instructions from a file: the note written to
   * a directory of the agent's own, and the environment naming it. With
   * the note off, the directory goes so a stale one is not read.
   */
  private async noteEnv(
    agent: Agent,
    adapter: AgentAdapter,
    note: string | null,
  ): Promise<Record<string, string> | undefined> {
    if (!adapter.noteFile) return undefined;
    const dir = path.join(this.config.dataDir, 'harness', agent.id);
    if (!note) {
      await fs.rm(dir, { recursive: true, force: true });
      return undefined;
    }
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, adapter.noteFile), note);
    return adapter.startEnv?.({ noteDir: dir });
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
        settled: null,
        fromCache: false,
        usage: null,
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
    // Replies replayed from history produce follow-ups that are history
    // too: drop them. What the process is still owed is judged by the
    // adapter from the whole log, once, now.
    void boundary;
    sl.pendingSends.splice(0);
    // Every turn that reached the log has now been matched to its author;
    // an author still pending belongs to a turn that never got there.
    if (sl.replayed && sl.id === agent.currentSessionId)
      live.pendingAuthors.length = 0;
    if (
      sl.replayed &&
      sl.adapter.afterReplay &&
      sl.id === agent.currentSessionId
    ) {
      const owed = sl.adapter.afterReplay({
        cwd: agent.cwd,
        resume: agent.vendorConversationId,
        permissions: agent.permissions,
        note: agent.harnessNote,
      });
      if (owed.length) this.sendLines(agent, sl, owed);
    }
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
    this.writeCache(agent, live);
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
    this.settle(agent, live, sl);
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
    let turnEnded = false;
    for (const op of ingest.ops ?? []) {
      this.applyOp(agent.id, live, sl, record.seq, op, record.t);
      if (op.item.kind === 'turn_end') turnEnded = true;
    }
    // Work landing is worth a line of its own in the transcript: the
    // vendor says it happened, nothing else in the stream does.
    if (ingest.committed)
      this.applyOp(
        agent.id,
        live,
        sl,
        record.seq,
        {
          op: 'append',
          item: {
            kind: 'system',
            text: ingest.committed.branch
              ? `committed on ${ingest.committed.branch}`
              : 'committed',
          },
        },
        record.t,
      );
    if (ingest.send?.length) {
      if (sl.attaching)
        sl.pendingSends.push({ seq: record.seq, lines: ingest.send });
      else this.sendLines(agent, sl, ingest.send);
    }
    // State from a session that is no longer current is history, not now;
    // state from a replay in flight is applied but announced only at its end.
    if (ingest.background !== undefined && sl.id === agent.currentSessionId)
      this.setBackground(agent, live, ingest.background, sl.attaching);
    if (ingest.usage) sl.usage = ingest.usage;
    if (ingest.usage && sl.id === agent.currentSessionId) {
      const usage = this.withTotal(live, sl, ingest.usage);
      live.status = { ...live.status, usage };
      this.noteUsage(agent, usage);
      if (sl.attaching) live.stateHeld = true;
      else this.emit('state', agent.id, agent.projectId, live.status);
    }
    if (
      ingest.model !== undefined &&
      sl.id === agent.currentSessionId &&
      live.status.model !== ingest.model
    ) {
      live.status = { ...live.status, model: ingest.model };
      if (sl.attaching) live.stateHeld = true;
      else this.emit('state', agent.id, agent.projectId, live.status);
    }
    if (ingest.state && sl.id === agent.currentSessionId)
      this.setState(
        agent,
        live,
        ingest.state,
        ingest.error ?? null,
        sl.attaching,
        record.t,
      );
    // A content hint only says something while the state itself does not
    // change (a state transition's own activity is setState's to derive).
    if (
      ingest.activity !== undefined &&
      !ingest.state &&
      sl.id === agent.currentSessionId
    )
      this.setActivity(agent, live, ingest.activity, sl.attaching, record.t);
    // At a turn end everything the session produced so far is final:
    // remember the adapter's state here so a restart can continue from it.
    if (turnEnded) this.settle(agent, live, sl);
  }

  /**
   * Marks everything of the session so far as cacheable, with the adapter
   * state and status of this moment, and writes the cache unless a replay
   * is in flight (its end writes once for all of it).
   */
  private settle(agent: Agent, live: Live, sl: SessionLive): void {
    const current = sl.id === agent.currentSessionId;
    sl.settled = {
      lastSeq: sl.lastSeq,
      end: live.itemBase + live.items.length,
      startedBoundary: sl.startedBoundary,
      endedBoundary: sl.endedBoundary,
      adapter: sl.adapter.snapshot?.() ?? null,
      status: current ? { ...live.status } : null,
      usage: sl.usage,
    };
    if (!sl.attaching) this.writeCache(agent, live);
  }

  /**
   * Appends the settled items the cache does not have yet and rewrites the
   * header; afterwards the resident list is cut back to its tail. Writes
   * are chained per agent; a failure disables the cache for the agent.
   */
  private writeCache(agent: Agent, live: Live): void {
    const cache = live.cache;
    if (cache.broken || !cache.loaded) return;
    let end = cache.claimed;
    for (const sl of live.sessions.values())
      if (sl.settled && sl.settled.end > end) end = sl.settled.end;
    if (end === cache.claimed && !this.headerDirty(live)) return;
    if (cache.claimed < live.itemBase) return; // cannot happen: only cached items are evicted
    const items = live.items.slice(
      cache.claimed - live.itemBase,
      end - live.itemBase,
    );
    const sessions: Record<string, CachedSession> = {};
    for (const sl of live.sessions.values())
      if (sl.settled && sl.settled.end <= end) {
        sessions[sl.id] = sl.settled;
        live.cacheHeaders.set(sl.id, sl.settled);
      }
    const header = { version: TRANSCRIPT_CACHE_VERSION, sessions };
    cache.claimed = end; // the next write starts after these items
    const gen = cache.generation;
    cache.chain = cache.chain
      .then(async () => {
        if (cache.broken || gen !== cache.generation) return; // rebuilt meanwhile
        await this.cache.append(agent.id, cache.written, items, header);
        if (gen === cache.generation) this.evict(live);
      })
      .catch((err: Error) => {
        cache.broken = true;
        this.logger.warn(
          `agent ${agent.id}: transcript cache disabled: ${err.message}`,
        );
      });
  }

  /** A session's settled point changed since the header was last written. */
  private headerDirty(live: Live): boolean {
    for (const sl of live.sessions.values())
      if (sl.settled && sl.settled !== live.cacheHeaders.get(sl.id))
        return true;
    return false;
  }

  /** Drops resident items the cache holds, keeping the configured tail. */
  private evict(live: Live): void {
    if (live.cache.broken) return;
    const droppable = Math.min(
      live.items.length - this.config.residentItems,
      live.cache.written.count - live.itemBase,
    );
    if (droppable <= 0) return;
    live.items.splice(0, droppable);
    live.itemBase += droppable;
  }

  /** Reads the cache once per process: the tail becomes resident and each cached session resumes from its snapshot. */
  private async loadCache(agent: Agent, live: Live): Promise<void> {
    if (live.cache.loaded) return;
    live.cache.loaded = true;
    const h = await this.cache.load(agent.id);
    if (!h) return;
    const state: CacheState = {
      count: h.count,
      bytes: h.bytes,
      offsets: h.offsets,
    };
    let tail: StoredItem[] = [];
    try {
      tail = await this.cache.read(
        agent.id,
        state,
        Math.max(0, h.count - this.config.residentItems),
        h.count,
      );
    } catch (err) {
      this.logger.warn(
        `agent ${agent.id}: transcript cache unreadable (${(err as Error).message}); rebuilding`,
      );
      await this.cache.clear(agent.id).catch(() => undefined);
      return;
    }
    const base = h.count - tail.length;
    if (
      tail.length !== Math.min(h.count, this.config.residentItems) ||
      tail.some((it, i) => it.index !== base + i)
    ) {
      this.logger.warn(
        `agent ${agent.id}: transcript cache unreadable; rebuilding`,
      );
      await this.cache.clear(agent.id).catch(() => undefined);
      return;
    }
    live.cache.written = state;
    live.cache.claimed = state.count;
    live.items = tail;
    live.itemBase = base;
    for (const [sid, cs] of Object.entries(h.sessions)) {
      const adapter = this.adapters.create(agent.profile);
      adapter.restore?.(cs.adapter);
      const sl = this.trackSession(agent, live, sid, adapter);
      sl.adapter = adapter; // an exit notice may have tracked it meanwhile, with a blank adapter
      sl.lastSeq = cs.lastSeq;
      sl.complete = true;
      sl.startedBoundary = cs.startedBoundary;
      sl.endedBoundary = cs.endedBoundary;
      sl.settled = cs;
      sl.fromCache = true;
      sl.usage = cs.usage ?? null;
      live.cacheHeaders.set(sid, cs);
    }
    this.restoreUsage(agent, live);
    this.logger.log(
      `agent ${agent.id}: ${h.count} item(s) from the transcript cache, ${Object.keys(h.sessions).length} session(s)`,
    );
  }

  /**
   * What the sessions just loaded from the cache said they had spent,
   * back on the status. Without this a restarted manager reports an
   * agent's spend as unknown until its next turn end — which blanks it in
   * the UI and, worse, moved a run's two readings onto different bases
   * (see Runs: the vendor's running totals). It puts back only what the
   * cache holds: the spend of each session and their total, with the time
   * of the report it came from. Windows, plan, context and the vendor's
   * verdict are a live account's business and are not invented here; the
   * next real report replaces all of it.
   */
  private restoreUsage(agent: Agent, live: Live): void {
    if (live.status.usage) return; // something live already said more
    const current = agent.currentSessionId
      ? live.sessions.get(agent.currentSessionId)
      : undefined;
    const sl = current?.usage
      ? current
      : [...live.sessions.values()].find((s) => s.usage);
    if (!sl?.usage) return;
    const usage = spendOnlyUsage(this.withTotal(live, sl, sl.usage));
    if (usage) live.status = { ...live.status, usage };
  }

  /** Starts the transcript over: resident items, cache and every session's cursor. */
  private rebuild(agent: Agent, live: Live, why: string): void {
    this.logger.log(`agent ${agent.id}: rebuilding transcript: ${why}`);
    live.items = [];
    live.itemBase = 0;
    live.cacheHeaders.clear();
    const cache = live.cache;
    cache.claimed = 0;
    cache.broken = false;
    cache.generation++;
    cache.chain = cache.chain
      .catch(() => undefined)
      .then(async () => {
        await this.cache.clear(agent.id);
        cache.written = { count: 0, bytes: 0, offsets: [] };
      })
      .catch((err: Error) => {
        cache.broken = true;
        this.logger.warn(
          `agent ${agent.id}: transcript cache disabled: ${err.message}`,
        );
      });
    for (const sl of live.sessions.values()) {
      sl.lastSeq = 0;
      sl.replayed = false;
      sl.complete = false;
      sl.suspended = true; // live frames must not advance the cursor before the replay attach
      sl.startedBoundary = false;
      sl.endedBoundary = false;
      sl.keys.clear();
      sl.settled = null;
      sl.fromCache = false;
      sl.adapter = this.adapters.create(agent.profile);
    }
    this.emit('reset', agent.id);
  }

  private applyOp(
    agentId: string,
    live: Live,
    sl: SessionLive,
    seq: number,
    op: ItemOp,
    at = Date.now(),
  ): void {
    if (op.op === 'update') {
      const index = sl.keys.get(op.key);
      if (index !== undefined && index >= live.itemBase) {
        const stored = live.items[index - live.itemBase];
        stored.item = op.item;
        stored.seqTo = seq;
        live.status.lastActivityAt = Date.now();
        this.emit('item', agentId, stored);
        return;
      }
    }
    if (op.item.kind === 'user') this.attribute(live, sl, seq, op.item);
    const stored = this.appendItem(agentId, live, sl.id, seq, op.item, at);
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
    let author = (
      this.db
        .prepare(
          'SELECT user_id FROM turn_authors WHERE daemon_session_id = ? AND seq = ?',
        )
        .get(sl.id, seq) as { user_id: string } | undefined
    )?.user_id;
    if (!author && live.pendingAuthors.length) {
      author = live.pendingAuthors.shift()!;
      this.db
        .prepare(
          'INSERT OR IGNORE INTO turn_authors (daemon_session_id, seq, user_id) VALUES (?, ?, ?)',
        )
        .run(sl.id, seq, author);
    }
    if (!author) return;
    if (author === MANAGER_AUTHOR) {
      item.by = MANAGER_AUTHOR; // the manager's own turn; there is no such user
      return;
    }
    const row = this.db
      .prepare('SELECT name FROM users WHERE id = ?')
      .get(author) as { name: string } | undefined;
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
    live.queued.length = 0; // held for a session that is gone
    live.status = { ...live.status, queued: 0 };
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
    for (const { id } of this.db
      .prepare('SELECT id FROM agents WHERE archived_at IS NULL')
      .all() as { id: string }[]) {
      const agent = this.find(id);
      if (agent) this.gate(this.ensureLive(agent));
    }
    // Archived agents are loaded on request; a new connection is a reason
    // to consult the daemon again for those loaded with a failed replay.
    for (const { id } of this.db
      .prepare('SELECT id FROM agents WHERE archived_at IS NOT NULL')
      .all() as { id: string }[]) {
      const live = this.live.get(id);
      if (live && [...live.sessions.values()].some((sl) => !sl.complete))
        live.loaded = false;
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

  /**
   * Waits for the pending resync to reach this agent. While the daemon is
   * down there is nothing to wait for: refuse now rather than hold the
   * request open and run it whenever the link returns.
   */
  private async awaitSynced(live: Live): Promise<void> {
    if (!this.daemon.connected)
      throw unavailable('the daemon is not connected');
    const timeout = new Promise<'timeout'>((r) =>
      setTimeout(() => r('timeout'), SYNC_WAIT_MS).unref(),
    );
    if ((await Promise.race([live.synced, timeout])) === 'timeout')
      throw unavailable('still catching up with the daemon; try again');
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
    // Archived agents are left alone here and loaded when somebody asks.
    const ids = (
      this.db
        .prepare('SELECT id FROM agents WHERE archived_at IS NULL')
        .all() as { id: string }[]
    ).map((r) => r.id);
    let done = 0;
    for (const id of ids) {
      if (generation !== this.resyncGeneration) return;
      const stale = this.find(id);
      if (!stale) continue;
      const live = this.ensureLive(stale);
      try {
        await this.withLock(live, () => this.resyncAgent(id, generation, live));
      } catch (err) {
        // The daemon link going away mid-resync ends it for everyone (a
        // new one follows the reconnect); anything else is this agent's.
        if (!this.daemon.connected) throw err;
        this.logger.warn(
          `agent ${id}: resync failed: ${(err as Error).message}`,
        );
        live.markSynced();
        continue;
      }
      done++;
    }
    this.logger.log(`resynced ${done} agent(s)`);
  }

  /** One agent's share of a resync; runs under the agent's lock. */
  private async resyncAgent(
    id: string,
    generation: number,
    live: Live,
  ): Promise<void> {
    const agent = this.find(id);
    if (!agent || generation !== this.resyncGeneration) return;
    await this.loadCache(agent, live);
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
    if (failedEarlier && live.itemBase + live.items.length > 0)
      this.rebuild(agent, live, 'recovered history must keep its order');
    // A cached session the daemon's log contradicts (cut short, or an
    // ended one with records past the cache) cannot be continued.
    // Items are cached in index order, so every cached session but the
    // last must be there whole: a session the daemon no longer has, one
    // cut short or run past, one missing from the cache while a later
    // one is in it, or one cached that the database does not know, would
    // all put recovered records after later history.
    const inRefs = new Set(refs.map((r) => r.daemonSessionId));
    const contradicted =
      refs.some((ref, i) => {
        const s = byId.get(ref.daemonSessionId);
        const sl = live.sessions.get(ref.daemonSessionId);
        const last = i === refs.length - 1;
        // A session the daemon no longer has goes now, as it would at the
        // next start, whether its items came from the cache or the log.
        if (!s) return sl !== undefined && sl.lastSeq > 0;
        if (!sl?.fromCache)
          return refs
            .slice(i + 1)
            .some((r) => live.sessions.get(r.daemonSessionId)?.fromCache);
        if (sl.lastSeq > s.lastSeq) return true;
        if (last) return false;
        return sl.lastSeq !== s.lastSeq || !sl.endedBoundary;
      }) ||
      [...live.sessions.values()].some(
        (sl) => sl.fromCache && !inRefs.has(sl.id),
      );
    if (contradicted)
      this.rebuild(agent, live, 'the cache disagrees with the daemon log');
    refs = this.sessions(agent.id);
    for (const [i, ref] of refs.entries()) {
      if (generation !== this.resyncGeneration) return;
      const s = byId.get(ref.daemonSessionId);
      if (!s) continue;
      const sl = this.trackSession(
        agent,
        live,
        s.id,
        live.sessions.get(s.id)?.adapter ?? this.adapters.create(agent.profile),
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
        // Provisional, quietly: the replay that follows knows better. A
        // cached session brings the status it had at its last turn end;
        // the replay from there is short and refines it.
        const cached = sl.fromCache ? sl.settled?.status : null;
        if (cached) {
          this.setState(agent, live, cached.state, cached.error, true);
          live.status = { ...cached, queued: 0 }; // nothing survives a restart
          live.stateHeld = true;
          if (cached.usage) this.noteUsage(agent, cached.usage); // the account's state as of the cache
        } else
          this.setState(
            agent,
            live,
            sl.adapter.initialState ?? 'starting',
            null,
            true,
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
    for (const sl of live.sessions.values()) sl.fromCache = false;
    this.writeCache(agent, live);
    live.loaded = true;
    live.markSynced();
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
          model: null,
          queued: 0,
          usage: null,
          activity: null,
        },
        items: [],
        itemBase: 0,
        cache: {
          claimed: 0,
          written: { count: 0, bytes: 0, offsets: [] },
          chain: Promise.resolve(),
          loaded: false,
          broken: false,
          generation: 0,
        },
        cacheHeaders: new Map(),
        loaded: false,
        lock: Promise.resolve(),
        synced: Promise.resolve(),
        markSynced: () => undefined,
        syncPending: false,
        adoptionNeeded: true,
        stateHeld: false,
        pendingAuthors: [],
        queued: [],
        flushing: false,
        lastPokeAt: 0,
        lastActivityEmitAt: 0,
        activityFlush: null,
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
    at = Date.now(),
  ): StoredItem {
    const stored: StoredItem = {
      index: live.itemBase + live.items.length,
      sessionId,
      seqFrom: seq,
      seqTo: seq,
      at,
      item,
    };
    live.items.push(stored);
    live.status.lastActivityAt = Date.now();
    this.emit('item', agentId, stored);
    return stored;
  }

  /**
   * Records the status; announces it unless `quiet` (a replay in flight), in
   * which case `releaseState` will. `activity` follows the transition:
   * `waiting-permission` sets it to `waiting`, any other real change of
   * `state` clears it (a turn beginning or ending has nothing to show yet),
   * and a call that only changes `error` (same `state`) leaves it alone.
   * `at` is the record time behind the transition, for `activity.since`.
   */
  private setState(
    agent: Agent,
    live: Live,
    state: AgentState,
    error: string | null,
    quiet = false,
    at: number = Date.now(),
  ): void {
    if (live.status.state === state && live.status.error === error) return;
    const activity: Activity =
      state === live.status.state
        ? live.status.activity
        : state === 'waiting-permission'
          ? { kind: 'waiting', since: at }
          : null;
    live.status = {
      state,
      error,
      lastActivityAt: Date.now(),
      // background jobs belong to the process; none survive its exit
      background: state === 'exited' ? 0 : live.status.background,
      model: state === 'exited' ? null : live.status.model,
      queued: live.status.queued,
      usage: live.status.usage,
      activity,
    };
    // A message held for the next turn goes as soon as the agent can take
    // one; a transition replayed from history is not that moment.
    if (state === 'idle' && live.queued.length && !quiet)
      setImmediate(() => void this.flushQueued(agent.id));
    if (quiet) {
      live.stateHeld = true;
      return;
    }
    live.stateHeld = false;
    if (live.activityFlush) {
      clearTimeout(live.activityFlush);
      live.activityFlush = null;
    }
    live.lastActivityEmitAt = Date.now();
    this.emit('state', agent.id, agent.projectId, live.status);
    this.emit('counts', agent.projectId, this.counts(agent.projectId));
  }

  /**
   * A mid-turn content hint from the adapter (thinking, writing, a tool):
   * applied to the status at once, announced on change like any other
   * status field, but coalesced to at most one announcement a second while
   * it keeps changing, so a burst of small tool calls does not flood the
   * socket; a state transition's own activity (set by `setState`) is never
   * throttled. A pending coalesce always fires with the latest value.
   */
  private setActivity(
    agent: Agent,
    live: Live,
    hint: {
      kind: Exclude<ActivityKind, 'waiting'>;
      detail?: string;
      tokens?: number;
    } | null,
    quiet: boolean,
    at: number,
  ): void {
    const cur = live.status.activity;
    const sameActivity =
      (cur?.kind ?? null) === (hint?.kind ?? null) &&
      (cur?.detail ?? undefined) === (hint?.detail ?? undefined);
    // A token count that grows within the same activity is still a change
    // worth announcing, but does not restart `since`: the activity itself
    // has not changed, only how much of it has been produced so far.
    if (
      sameActivity &&
      (cur?.tokens ?? undefined) === (hint?.tokens ?? undefined)
    )
      return;
    const since = sameActivity && cur ? cur.since : at;
    live.status = {
      ...live.status,
      activity: hint
        ? { kind: hint.kind, detail: hint.detail, tokens: hint.tokens, since }
        : null,
    };
    if (quiet) {
      live.stateHeld = true;
      return;
    }
    // A change of what it does (thinking to a tool, one tool to the next)
    // is discrete and rare: announced at once, or a reader sees the
    // transcript's tool call a second before the line says so. Only the
    // token count growing within the same activity waits out the window.
    this.announceActivity(agent, live, !sameActivity);
  }

  /** Emits the current status now if the throttle window is open (or `now` says so), or schedules it for when it opens. */
  private announceActivity(agent: Agent, live: Live, now_ = false): void {
    const now = Date.now();
    const wait = now_ ? 0 : live.lastActivityEmitAt + 1000 - now;
    if (wait <= 0) {
      if (live.activityFlush) {
        clearTimeout(live.activityFlush); // the scheduled one would only repeat this status
        live.activityFlush = null;
      }
      live.lastActivityEmitAt = now;
      live.stateHeld = false;
      this.emit('state', agent.id, agent.projectId, live.status);
      return;
    }
    if (live.activityFlush) return; // already scheduled; it reads live.status when it fires
    live.activityFlush = setTimeout(() => {
      live.activityFlush = null;
      live.lastActivityEmitAt = Date.now();
      live.stateHeld = false;
      this.emit('state', agent.id, agent.projectId, live.status);
    }, wait);
    live.activityFlush.unref();
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
    live.lastActivityEmitAt = Date.now();
    this.emit('state', agent.id, agent.projectId, live.status);
    this.emit('counts', agent.projectId, this.counts(agent.projectId));
    if (live.status.state === 'idle' && live.queued.length)
      setImmediate(() => void this.flushQueued(agent.id));
  }
}

/** Images a turn may carry: a few, small enough to travel in one daemon log line with room to spare. */
export const IMAGE_LIMITS = {
  count: 4,
  /** raw bytes per image */
  bytes: 3 * 1024 * 1024,
  /** raw bytes per turn */
  total: 6 * 1024 * 1024,
  types: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
};

/** Base64 as a vendor accepts it: the alphabet, padding only at the end, whole groups, not empty. Linear, since an image is megabytes. */
function isBase64(s: string): boolean {
  if (s.length === 0 || s.length % 4 !== 0) return false;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const body = s.slice(0, s.length - pad);
  return /^[A-Za-z0-9+/]*$/.test(body); // no groups: no backtracking on a huge string
}
/** What the held-message queue may carry per agent: messages, and bytes of images among them. */
const QUEUE_LIMITS = { messages: 20, imageBytes: 24 * 1024 * 1024 };

/** `images` from a request: `[{ mediaType, data }]`, base64, within IMAGE_LIMITS. */
function parseImages(raw: unknown): TurnImage[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw))
    throw new BadRequestException('"images" must be a list');
  if (raw.length > IMAGE_LIMITS.count)
    throw new BadRequestException(
      `at most ${IMAGE_LIMITS.count} images per turn`,
    );
  let total = 0;
  const out: TurnImage[] = [];
  for (const i of raw as unknown[]) {
    const o = (i ?? {}) as { mediaType?: unknown; data?: unknown };
    if (
      typeof o.mediaType !== 'string' ||
      !IMAGE_LIMITS.types.includes(o.mediaType)
    )
      throw new BadRequestException(
        `image type must be one of ${IMAGE_LIMITS.types.join(', ')}`,
      );
    if (typeof o.data !== 'string' || !isBase64(o.data))
      throw new BadRequestException('image data must be base64');
    const bytes = Math.floor((o.data.length * 3) / 4);
    if (bytes > IMAGE_LIMITS.bytes)
      throw new BadRequestException(
        `an image may be at most ${IMAGE_LIMITS.bytes / 1024 / 1024} MB`,
      );
    total += bytes;
    if (total > IMAGE_LIMITS.total)
      throw new BadRequestException(
        `images may total at most ${IMAGE_LIMITS.total / 1024 / 1024} MB per turn`,
      );
    out.push({ mediaType: o.mediaType, data: o.data });
  }
  return out;
}
