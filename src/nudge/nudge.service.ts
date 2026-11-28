import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { AgentState } from '../adapters/adapter.js';
import { AgentsService, MANAGER_AUTHOR } from '../agents/agents.service.js';
import type { AgentStatus } from '../agents/agents.service.js';
import { MANAGER_CONFIG } from '../config/config.js';
import type { ManagerConfig } from '../config/config.js';
import { DbService } from '../db/db.service.js';
import { PushService } from '../push/push.service.js';
import { StatsService } from '../stats/stats.service.js';
import { runModel } from '../util/run-model.js';
import {
  due,
  lastTurn,
  nudgeText,
  parseReading,
  readerInput,
} from './nudge.js';

/** How far back the end of a transcript is read for the turn that just ended. */
const TAIL = 600;
/** For this long after the manager starts, an agent that does not look idle may simply not have been found again yet: a nudge whose time has come waits for it. */
const RESTART_GRACE_MS = 60_000;
/** At this share of an account's usage window nobody is asked to go on: the work would stop half-way. */
const NEARLY_SPENT = 95;

const hhmm = (at: number): string => {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * Asks an agent that stopped whether it can go on, for agents that
 * have this turned on (`agent.nudge`). At the end of a turn a model
 * reads the agent's last message: if it needs the person they are
 * paged, if it says the work is done nothing happens, and otherwise,
 * a few minutes later and unless a person says something first, the
 * manager shows the agent, in its own name, what its last message left
 * open and asks which of it needs the person. Never an order; and two
 * nudges are at least half an hour apart, so one that cannot do more is
 * not pressed again and again.
 *
 * What is pending is kept (`agent_nudges_due`): a manager restarted
 * while a nudge waits sends it when its time comes.
 */
@Injectable()
export class NudgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NudgeService.name);
  private readonly startedAt = Date.now();
  /** Each agent's state as last seen, to tell a turn's end from any other change while idle. */
  private readonly was = new Map<string, AgentState>();
  /** Agents whose last message is being read; a reading that comes back for one no longer here is dropped. */
  private readonly reading = new Map<string, symbol>();
  /** Nudges waiting to go. */
  private readonly pending = new Map<
    string,
    { timer: NodeJS.Timeout; inRow: number; text: string }
  >();

  constructor(
    @Inject(MANAGER_CONFIG) private readonly config: ManagerConfig,
    private readonly dbs: DbService,
    private readonly agents: AgentsService,
    private readonly stats: StatsService,
    private readonly push: PushService,
  ) {}

  private get db() {
    return this.dbs.db;
  }

  onModuleInit(): void {
    this.agents.on('state', (agentId, _projectId, status) =>
      this.onState(agentId, status),
    );
    this.agents.on('updated', (agent) => {
      if (!agent.nudge) this.drop(agent.id);
    });
    this.agents.on('removed', (agentId) => {
      this.drop(agentId);
      this.was.delete(agentId);
    });
    this.agents.on('archived', (agentId) => this.drop(agentId));
    // What was waiting when the manager stopped: sent when its time
    // comes, and not before the agents have been found again (a turn
    // under way then shows as one, and drops it like any other).
    for (const r of this.db
      .prepare('SELECT agent_id, due_at, in_row, text FROM agent_nudges_due')
      .all() as {
      agent_id: string;
      due_at: number;
      in_row: number;
      text: string;
    }[]) {
      const at = Math.max(r.due_at, Date.now() + 1000);
      try {
        this.schedule(r.agent_id, at, r.in_row, r.text);
      } catch {
        // the agent is gone
        this.db
          .prepare('DELETE FROM agent_nudges_due WHERE agent_id = ?')
          .run(r.agent_id);
      }
    }
  }

  /** Sets a nudge to go at `at`, on record and on the status. */
  private schedule(
    agentId: string,
    at: number,
    inRow: number,
    text: string,
  ): void {
    this.agents.get(agentId); // throws for one that is gone
    const old = this.pending.get(agentId);
    if (old) clearTimeout(old.timer);
    this.db
      .prepare(
        'INSERT INTO agent_nudges_due (agent_id, due_at, in_row, text) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET due_at = excluded.due_at, in_row = excluded.in_row, text = excluded.text',
      )
      .run(agentId, at, inRow, text);
    const timer = setTimeout(
      () =>
        void this.fire(agentId).catch((err: Error) =>
          this.logger.warn(`agent ${agentId}: nudge failed: ${err.message}`),
        ),
      Math.max(0, at - Date.now()),
    );
    timer.unref();
    this.pending.set(agentId, { timer, inRow, text });
    this.agents.setNudge(agentId, { state: 'waiting', at });
  }

  /** The manager is going down: what waits stays on record for the next one, and nothing more is done here. */
  private closed = false;

  onModuleDestroy(): void {
    this.closed = true;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  private onState(agentId: string, status: AgentStatus): void {
    if (this.closed) return;
    const before = this.was.get(agentId);
    this.was.set(agentId, status.state);
    // The session ended, or the link to the daemon dropped (which looks the
    // same from here, and is what a manager going down sees last): no
    // turn began. Whether a question that waits still goes is settled
    // when its time comes: it goes only to an agent that is idle then.
    if (status.state === 'exited' || status.state === 'error') return;
    // just after a start an agent being found again passes through `starting`: no news either
    if (
      status.state === 'starting' &&
      before === undefined &&
      Date.now() - this.startedAt < RESTART_GRACE_MS
    )
      return;
    if (status.state !== 'idle') {
      // a turn began (a person wrote, or the nudge went) or the session ended: nothing is waiting any more
      this.drop(agentId);
      return;
    }
    if (before === 'working' || before === 'waiting-permission')
      void this.stopped(agentId).catch((err: Error) =>
        this.logger.warn(`agent ${agentId}: ${err.message}`),
      );
  }

  /** Forgets what is pending for an agent, without a word in the flow. */
  private drop(agentId: string): void {
    const p = this.pending.get(agentId);
    if (p) clearTimeout(p.timer);
    this.pending.delete(agentId);
    this.reading.delete(agentId);
    this.db
      .prepare('DELETE FROM agent_nudges_due WHERE agent_id = ?')
      .run(agentId);
    this.agents.setNudge(agentId, null);
  }

  /**
   * A person calls it off (the button on the notice over the flow's
   * input): they are here and will say what happens next. Says so in
   * the flow when something was pending.
   */
  hold(agentId: string, by: string): boolean {
    this.agents.get(agentId); // 404 for an unknown agent
    const was = this.pending.has(agentId) || this.reading.has(agentId);
    this.drop(agentId);
    if (was)
      this.agents.note(
        agentId,
        `not asked whether it can go on: ${by} called it off`,
      );
    return was;
  }

  /** A turn just ended. */
  private async stopped(agentId: string): Promise<void> {
    const reader = this.config.nudgeReader;
    const agent = this.agents.get(agentId);
    if (!reader || !agent.nudge || agent.archivedAt) return;
    const status = this.agents.status(agentId);
    // a background job's end starts a turn of its own, and that turn's end is read
    if (status.background > 0) return;
    if (status.holdUntil !== null && status.holdUntil > Date.now()) return;
    const usage = status.usage;
    if (
      usage &&
      (usage.status === 'rejected' ||
        usage.windows.some((w) => w.usedPercent >= NEARLY_SPENT))
    )
      return;
    const mine = Symbol();
    this.reading.set(agentId, mine);
    this.agents.setNudge(agentId, { state: 'reading', at: null });
    const still = () =>
      this.reading.get(agentId) === mine &&
      this.agents.status(agentId).state === 'idle';
    const { items } = await this.agents.items(agentId, { tail: TAIL });
    const turn = lastTurn(items);
    if (turn.stoppedByPerson) {
      if (still()) this.drop(agentId);
      return; // they stopped it: it is theirs to say what next
    }
    let read;
    try {
      read = turn.text
        ? parseReading(
            await runModel(reader, readerInput(turn), {
              cwd: this.config.dataDir,
              timeoutMs: this.config.nudgeReaderMs,
            }),
          )
        : {
            verdict: 'paused' as const,
            why: 'it stopped without a word',
            open: [],
          };
    } catch (err) {
      // an agent is not asked on the strength of a reading that did not happen
      this.logger.warn(
        `agent ${agentId}: its last message could not be read: ${(err as Error).message}`,
      );
      if (still()) this.drop(agentId);
      return;
    }
    if (!still()) return; // something happened meanwhile: a message, a hold, the setting turned off
    if (read.verdict === 'needs_person') {
      this.drop(agentId);
      this.agents.note(
        agentId,
        `stopped, and needs a person: ${read.why}; paged`,
      );
      await this.push
        .notify(null, {
          title: `${agent.name} needs you`,
          body: read.why,
          url: `/projects/${agent.projectId}/agents/${agent.id}`,
          tag: `agent-${agent.id}`,
        })
        .catch((err: Error) =>
          this.logger.warn(`agent ${agentId}: paging failed: ${err.message}`),
        );
      return;
    }
    if (read.verdict === 'done') {
      this.drop(agentId);
      this.agents.note(
        agentId,
        `stopped: it says the work is done (${read.why})`,
      );
      return;
    }
    const last = this.last(agentId);
    const { personAt } = await this.stats.since(agentId, last?.at ?? 0);
    if (!still()) return;
    this.reading.delete(agentId);
    const ok = due(last, personAt, {
      restMs: this.config.nudgeRestMs,
      maxInRow: this.config.nudgeMaxInRow,
    });
    if (!ok.ok) {
      this.agents.setNudge(agentId, null);
      this.agents.note(
        agentId,
        `stopped with work left (${read.why}); not asked whether it can go on: ${ok.why}`,
      );
      return;
    }
    // a person gets the usual wait to say something first; after a nudge, the next keeps its distance from it
    const at = Math.max(Date.now() + this.config.nudgeDelayMs, ok.notBefore);
    this.agents.note(
      agentId,
      `stopped with work left (${read.why}); the manager asks it at ${hhmm(at)} whether it can go on, unless a person says something first`,
    );
    this.schedule(
      agentId,
      at,
      ok.inRow,
      nudgeText(read.open, personAt === null ? null : Date.now() - personAt),
    );
  }

  /** The wait is over: the question goes, as a turn of the manager's own. */
  private async fire(agentId: string): Promise<void> {
    const p = this.pending.get(agentId);
    if (!p || this.closed) return;
    // just after a start the agents are still being found again: not idle yet is not "in a turn"
    if (
      Date.now() - this.startedAt < RESTART_GRACE_MS &&
      this.agents.status(agentId).state !== 'idle'
    ) {
      this.schedule(agentId, Date.now() + 1000, p.inRow, p.text);
      return;
    }
    // taken off the list before the turn starts: the turn's own change of state must not read as a person stepping in
    this.pending.delete(agentId);
    this.db
      .prepare('DELETE FROM agent_nudges_due WHERE agent_id = ?')
      .run(agentId);
    this.agents.setNudge(agentId, null);
    const agent = this.agents.get(agentId);
    const status = this.agents.status(agentId);
    if (!agent.nudge || status.background > 0) return;
    if (status.state !== 'idle') {
      this.agents.note(
        agentId,
        `not asked whether it can go on: it is ${status.state === 'exited' ? 'not running' : status.state} now`,
      );
      return;
    }
    this.db
      .prepare(
        'INSERT INTO agent_nudges (agent_id, last_at, in_row) VALUES (?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET last_at = excluded.last_at, in_row = excluded.in_row',
      )
      .run(agentId, Date.now(), p.inRow);
    await this.agents.turn(agentId, p.text, MANAGER_AUTHOR);
  }

  /** The last nudge sent to an agent, and how many in a row it made. */
  private last(agentId: string): { at: number; inRow: number } | null {
    const r = this.db
      .prepare('SELECT last_at, in_row FROM agent_nudges WHERE agent_id = ?')
      .get(agentId) as { last_at: number; in_row: number } | undefined;
    return r ? { at: r.last_at, inRow: r.in_row } : null;
  }
}
