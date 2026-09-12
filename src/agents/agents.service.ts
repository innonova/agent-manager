import {
  BadRequestException,
  ConflictException,
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
  seq: number;
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

/** Everything about an agent that is rebuilt from the daemon, never stored. */
interface Live {
  adapter: AgentAdapter | null;
  status: AgentStatus;
  items: StoredItem[];
  /** seq of the last record ingested for the current session. */
  lastSeq: number;
  /** A turn arrived while the session was still being (re)started. */
  starting: Promise<void> | null;
}

export interface AgentEvents {
  state: [agentId: string, projectId: string, status: AgentStatus];
  item: [agentId: string, item: StoredItem];
  session: [agentId: string, session: AgentSessionRef];
  counts: [projectId: string, counts: AgentCounts];
}

export const LABEL_PREFIX = 'agent-manager:';

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
 * The daemon's log records flow through the agent's adapter into items and
 * state; on (re)connect every known session is replayed from where we left
 * off (or from the start after a manager restart).
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
    this.daemon.on(
      'connected',
      () =>
        void this.resync().catch((err: Error) =>
          this.logger.error(`resync failed: ${err.message}`),
        ),
    );
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

  status(id: string): AgentStatus {
    return this.ensureLive(this.get(id)).status;
  }

  sessions(id: string): AgentSessionRef[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM agent_sessions WHERE agent_id = ? ORDER BY started_at',
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
    const cwd = (input.cwd as string | undefined) ?? project.path;
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
    await this.startSession(agent, live);
    return { agent: this.get(agent.id), status: live.status };
  }

  /** Sends a user turn; starts or resumes a session first if none is live. */
  async turn(id: string, text: unknown): Promise<void> {
    if (typeof text !== 'string' || text.length === 0)
      throw new BadRequestException('"text" is required');
    let agent = this.get(id);
    if (agent.archivedAt) throw new ConflictException('agent is archived');
    const live = this.ensureLive(agent);
    if (live.starting) await live.starting;
    agent = this.get(id);
    if (!agent.currentSessionId) {
      await this.startSession(agent, live);
      agent = this.get(id);
    }
    for (const line of live.adapter!.turn(text))
      await this.daemon.input(agent.currentSessionId!, line);
  }

  async interrupt(id: string): Promise<void> {
    const agent = this.get(id);
    const live = this.ensureLive(agent);
    if (!agent.currentSessionId || !live.adapter?.interrupt)
      throw new ConflictException('nothing to interrupt');
    for (const line of live.adapter.interrupt())
      await this.daemon.input(agent.currentSessionId, line);
  }

  /** Ends the current session politely; the agent stays resumable. */
  async stop(id: string): Promise<void> {
    const agent = this.get(id);
    if (!agent.currentSessionId) return;
    try {
      await this.daemon.endInput(agent.currentSessionId);
    } catch (err) {
      if (!(err instanceof DaemonError) || err.code === 'disconnected')
        throw err;
      await this.daemon
        .signal(agent.currentSessionId, 'SIGTERM')
        .catch(() => undefined);
    }
  }

  async archive(id: string): Promise<void> {
    await this.stop(id);
    this.db
      .prepare('UPDATE agents SET archived_at = ? WHERE id = ?')
      .run(Date.now(), id);
    const agent = this.get(id);
    this.emit('counts', agent.projectId, this.counts(agent.projectId));
  }

  // ---- sessions -----------------------------------------------------------

  private async startSession(agent: Agent, live: Live): Promise<void> {
    if (live.starting) return live.starting;
    live.starting = (async () => {
      const adapter = this.adapters.create(agent.profile);
      live.adapter = adapter;
      live.lastSeq = 0;
      const session = await this.daemon.start({
        profile: agent.profile,
        args: adapter.startArgs({ resume: agent.vendorConversationId }),
        cwd: agent.cwd,
        label: `${LABEL_PREFIX}${agent.id}`,
        attach: true,
      });
      this.db
        .prepare(
          'INSERT INTO agent_sessions (daemon_session_id, agent_id, started_at) VALUES (?, ?, ?)',
        )
        .run(session.id, agent.id, session.startedAt);
      this.db
        .prepare('UPDATE agents SET current_session_id = ? WHERE id = ?')
        .run(session.id, agent.id);
      this.sessionOwner.set(session.id, agent.id);
      this.appendItem(agent.id, live, session.id, 0, {
        kind: 'system',
        text: agent.vendorConversationId
          ? `session resumed (${session.id})`
          : `session started (${session.id})`,
      });
      this.setState(agent, live, 'idle', null);
      this.emit('session', agent.id, {
        daemonSessionId: session.id,
        startedAt: session.startedAt,
        endedAt: null,
      });
    })().finally(() => {
      live.starting = null;
    });
    return live.starting;
  }

  private onOutput(sessionId: string, record: LogRecord): void {
    const agentId = this.sessionOwner.get(sessionId);
    if (!agentId) return;
    const live = this.live.get(agentId);
    if (!live?.adapter) return;
    if (record.seq <= live.lastSeq) return; // replay overlap after a reconnect
    live.lastSeq = record.seq;
    const agent = this.get(agentId);
    this.apply(agent, live, sessionId, record, live.adapter.ingest(record));
  }

  private apply(
    agent: Agent,
    live: Live,
    sessionId: string,
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
    if (ingest.updateLast) {
      const last = live.items[live.items.length - 1];
      if (last && last.item.kind === ingest.updateLast.kind) {
        last.item = ingest.updateLast;
        last.seq = record.seq;
        this.emit('item', agent.id, last);
      } else {
        this.appendItem(
          agent.id,
          live,
          sessionId,
          record.seq,
          ingest.updateLast,
        );
      }
    }
    for (const item of ingest.append ?? [])
      this.appendItem(agent.id, live, sessionId, record.seq, item);
    if (ingest.state)
      this.setState(agent, live, ingest.state, ingest.error ?? null);
  }

  private onSessionChanged(session: DaemonSession): void {
    const agentId =
      this.sessionOwner.get(session.id) ??
      (session.label?.startsWith(LABEL_PREFIX)
        ? session.label.slice(LABEL_PREFIX.length)
        : undefined);
    if (!agentId || session.state !== 'exited') return;
    const row = this.db
      .prepare('SELECT * FROM agents WHERE id = ?')
      .get(agentId) as AgentRow | undefined;
    if (!row) return;
    const agent = toAgent(row);
    const live = this.ensureLive(agent);
    this.db
      .prepare(
        'UPDATE agent_sessions SET ended_at = ? WHERE daemon_session_id = ?',
      )
      .run(session.exitedAt ?? Date.now(), session.id);
    if (agent.currentSessionId === session.id) {
      this.db
        .prepare('UPDATE agents SET current_session_id = NULL WHERE id = ?')
        .run(agent.id);
      agent.currentSessionId = null;
      const why = session.exitReason
        ? ` (${session.exitReason})`
        : session.signal
          ? ` (${session.signal})`
          : ` (exit code ${session.exitCode})`;
      this.appendItem(agent.id, live, session.id, session.lastSeq, {
        kind: 'system',
        text: `session ended${why}`,
      });
      this.setState(agent, live, 'exited', null);
      this.emit('session', agent.id, {
        daemonSessionId: session.id,
        startedAt: session.startedAt,
        endedAt: session.exitedAt,
      });
    }
  }

  /** After (re)connecting to the daemon: rebuild every agent from its sessions. */
  private async resync(): Promise<void> {
    const sessions = await this.daemon.listSessions();
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const rows = this.db
      .prepare('SELECT * FROM agents WHERE archived_at IS NULL')
      .all() as AgentRow[];
    for (const row of rows) {
      const agent = toAgent(row);
      const live = this.ensureLive(agent);
      const refs = this.sessions(agent.id);
      // Adopt sessions the daemon knows about that we lost track of.
      for (const s of sessions) {
        if (
          s.label === `${LABEL_PREFIX}${agent.id}` &&
          !refs.some((r) => r.daemonSessionId === s.id)
        ) {
          this.db
            .prepare(
              'INSERT INTO agent_sessions (daemon_session_id, agent_id, started_at, ended_at) VALUES (?, ?, ?, ?)',
            )
            .run(s.id, agent.id, s.startedAt, s.exitedAt);
          refs.push({
            daemonSessionId: s.id,
            startedAt: s.startedAt,
            endedAt: s.exitedAt,
          });
        }
      }
      const fresh = live.items.length === 0;
      if (fresh) {
        // Full rebuild: replay every session in order.
        for (const [i, ref] of refs.entries()) {
          const s = byId.get(ref.daemonSessionId);
          if (!s) continue;
          await this.replay(
            agent,
            live,
            s,
            1,
            i === 0 ? 'session started' : 'session resumed',
          );
        }
      } else if (agent.currentSessionId && byId.has(agent.currentSessionId)) {
        // Reconnect: only what we missed of the live session.
        await this.replay(
          agent,
          live,
          byId.get(agent.currentSessionId)!,
          live.lastSeq + 1,
        );
      }
      const current = agent.currentSessionId
        ? byId.get(agent.currentSessionId)
        : undefined;
      if (agent.currentSessionId && (!current || current.state === 'exited')) {
        if (current) this.onSessionChanged(current);
        else {
          this.db
            .prepare('UPDATE agents SET current_session_id = NULL WHERE id = ?')
            .run(agent.id);
          this.setState(agent, live, 'exited', null);
        }
      }
    }
    this.logger.log(
      `resynced ${rows.length} agent(s) against ${sessions.length} daemon session(s)`,
    );
  }

  private async replay(
    agent: Agent,
    live: Live,
    session: DaemonSession,
    fromSeq: number,
    label = 'session started',
  ): Promise<void> {
    live.adapter =
      live.adapter && session.id === agent.currentSessionId && fromSeq > 1
        ? live.adapter
        : this.adapters.create(agent.profile);
    this.sessionOwner.set(session.id, agent.id);
    if (fromSeq === 1) {
      live.lastSeq = 0;
      this.appendItem(agent.id, live, session.id, 0, {
        kind: 'system',
        text: `${label} (${session.id})`,
      });
    }
    try {
      await this.daemon.attach(session.id, fromSeq); // records arrive through onOutput before this resolves
    } catch (err) {
      this.logger.warn(
        `replay of ${session.id} for agent ${agent.id} failed: ${(err as Error).message}`,
      );
      this.appendItem(agent.id, live, session.id, 0, {
        kind: 'system',
        text: `history unavailable: ${(err as Error).message}`,
      });
    }
    if (session.state === 'exited' && session.id !== agent.currentSessionId) {
      this.appendItem(agent.id, live, session.id, session.lastSeq, {
        kind: 'system',
        text: 'session ended',
      });
    }
  }

  private onDaemonLost(): void {
    for (const [agentId, live] of this.live) {
      const agent = this.get(agentId);
      if (live.status.state !== 'exited')
        this.setState(agent, live, 'error', 'connection to agent-daemon lost');
    }
  }

  // ---- helpers ------------------------------------------------------------

  private ensureLive(agent: Agent): Live {
    let live = this.live.get(agent.id);
    if (!live) {
      live = {
        adapter: null,
        status: {
          state: agent.currentSessionId ? 'starting' : 'exited',
          error: null,
          lastActivityAt: agent.createdAt,
        },
        items: [],
        lastSeq: 0,
        starting: null,
      };
      this.live.set(agent.id, live);
    }
    return live;
  }

  private appendItem(
    agentId: string,
    live: Live,
    sessionId: string,
    seq: number,
    item: Item,
  ): void {
    const stored: StoredItem = {
      index: live.items.length,
      sessionId,
      seq,
      item,
    };
    live.items.push(stored);
    live.status.lastActivityAt = Date.now();
    this.emit('item', agentId, stored);
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
