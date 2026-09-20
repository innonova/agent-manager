import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { OnModuleInit } from '@nestjs/common';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentsService, type StoredItem } from '../agents/agents.service.js';
import { head } from '../changes/git.js';
import { MANAGER_CONFIG, type ManagerConfig } from '../config/config.js';
import { DbService } from '../db/db.service.js';
import { FeaturesService } from '../features/features.service.js';
import { lastReport, readFeature } from '../features/feature-file.js';
import type { FeatureStatus } from '../features/feature-file.js';
import { ProjectsService, type Repo } from '../projects/projects.service.js';
import type { Project } from '../projects/projects.service.js';

/** How a run ended. `feature` is the ordinary one: the feature left `in-progress`. */
export type RunOutcome =
  'feature' | 'agent-exited' | 'agent-removed' | 'abandoned';

/** What the vendor says a stretch of work cost; every field is absent when it said nothing. */
export interface RunSpend {
  turns: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface Run extends RunSpend {
  id: string;
  projectId: string;
  projectName: string;
  host: string;
  repo: string;
  slug: string;
  agentId: string;
  agentName: string;
  profile: string;
  model: string | null;
  effort: string | null;
  permissions: string;
  startedAt: number;
  endedAt: number | null;
  /** The status the feature ended in; null while the run is open. */
  featureStatus: FeatureStatus | null;
  outcome: RunOutcome | null;
  baseCommit: string | null;
  endCommit: string | null;
  /** The agent's transcript indexes the run spans; `itemTo` is null while it is open. */
  itemFrom: number;
  itemTo: number | null;
  /** The report the agent appended to the feature, as text. */
  report: string | null;
}

interface RunRow {
  id: string;
  project_id: string;
  project_name: string;
  host: string;
  repo: string;
  slug: string;
  agent_id: string;
  agent_name: string;
  profile: string;
  model: string | null;
  effort: string | null;
  permissions: string;
  started_at: number;
  ended_at: number | null;
  feature_status: string | null;
  outcome: string | null;
  base_commit: string | null;
  end_commit: string | null;
  turns: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  item_from: number;
  item_to: number | null;
  report: string | null;
  transcript_file: string | null;
  start_spend: string | null;
}

/** How often open runs are checked against the idle timeout. */
const SWEEP_MS = 60_000;

/**
 * The log of feature runs: one agent's work on one feature, kept so that
 * models can be compared on real work after the agent is forgotten.
 *
 * A run opens when a feature goes `in-progress` and an agent can be held
 * responsible for it, and closes when the feature leaves `in-progress`.
 * The safety nets are for runs that never see that: the agent exits or is
 * forgotten, or nothing happens for `runIdleMs` and the run is abandoned.
 * Nothing here judges the work; it records what it cost and what was said.
 */
@Injectable()
export class RunsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RunsService.name);
  private timer: NodeJS.Timeout | null = null;
  /** One close at a time per run id: the sweep, an exit and a status change can all arrive together. */
  private closing = new Set<string>();

  constructor(
    private readonly dbs: DbService,
    private readonly projects: ProjectsService,
    private readonly features: FeaturesService,
    private readonly agents: AgentsService,
    @Inject(MANAGER_CONFIG) private readonly config: ManagerConfig,
  ) {}

  private get db() {
    return this.dbs.db;
  }

  onModuleInit(): void {
    this.features.onTransition((projectId, slug, was, now) =>
      this.onFeatureStatus(projectId, slug, was, now),
    );
    this.agents.onBeforeRemove((agentId) =>
      this.closeForAgent(agentId, 'agent-removed'),
    );
    this.agents.on('state', (agentId, _projectId, status) => {
      if (status.state !== 'exited') return;
      void this.closeForAgent(agentId, 'agent-exited').catch((err: Error) =>
        this.logger.warn(`run close after exit: ${err.message}`),
      );
    });
    this.timer = setInterval(() => {
      void this.sweep().catch((err: Error) =>
        this.logger.warn(`run sweep failed: ${err.message}`),
      );
    }, SWEEP_MS);
    this.timer.unref();
    // A run left open by a restart belongs to an agent that may be gone.
    void this.sweep().catch(() => undefined);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- reading --------------------------------------------------------------

  list(filter: {
    projectId?: string;
    slug?: string;
    model?: string;
    since?: number;
    limit?: number;
  }): Run[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.projectId) {
      where.push('project_id = ?');
      args.push(filter.projectId);
    }
    if (filter.slug) {
      where.push('slug = ?');
      args.push(filter.slug);
    }
    if (filter.model) {
      where.push('model = ?');
      args.push(filter.model);
    }
    if (filter.since !== undefined) {
      where.push('started_at >= ?');
      args.push(filter.since);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT ?`,
      )
      .all(...args, Math.min(filter.limit ?? 200, 1000)) as RunRow[];
    return rows.map(toRun);
  }

  get(id: string): Run | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as
      RunRow | undefined;
    return row ? toRun(row) : null;
  }

  /** The run's transcript, as exported when it closed; empty when there is no file (an open or abandoned run). */
  async transcript(id: string): Promise<StoredItem[]> {
    const row = this.db
      .prepare('SELECT transcript_file FROM runs WHERE id = ?')
      .get(id) as { transcript_file: string | null } | undefined;
    if (!row?.transcript_file) return [];
    try {
      const text = await fs.readFile(
        path.join(this.transcriptDir, row.transcript_file),
        'utf8',
      );
      return text
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as StoredItem);
    } catch {
      return [];
    }
  }

  private get transcriptDir(): string {
    return path.join(this.config.dataDir, 'runs');
  }

  // ---- opening and closing --------------------------------------------------

  private async onFeatureStatus(
    projectId: string,
    slug: string,
    was: FeatureStatus | null,
    now: FeatureStatus,
  ): Promise<void> {
    if (now === 'in-progress') {
      if (was !== 'in-progress') await this.open(projectId, slug);
      return;
    }
    if (was === 'in-progress') await this.closeForFeature(projectId, slug, now);
  }

  /**
   * The agent the run belongs to: the one working in the feature's own
   * repository, else the only agent working in the project. With no
   * candidate there is no run — an unattributed one would be worse than
   * none, since the numbers would belong to nobody.
   */
  private attribute(project: Project, repo: Repo | undefined) {
    const working = this.agents
      .list(project.id)
      .filter((a) => a.status.state === 'working');
    if (repo) {
      const here = working.filter((a) => a.agent.cwd === repo.path);
      if (here.length === 1) return here[0]!.agent;
    }
    return working.length === 1 ? working[0]!.agent : null;
  }

  private async open(projectId: string, slug: string): Promise<void> {
    if (
      this.db
        .prepare(
          'SELECT id FROM runs WHERE project_id = ? AND slug = ? AND ended_at IS NULL',
        )
        .get(projectId, slug)
    )
      return; // already running; a second in-progress is the same work
    const project = this.projects.get(projectId);
    const feature = await this.features.get(projectId, slug);
    const repo = project.repos.find((r) => r.name === feature.repo);
    const agent = this.attribute(project, repo);
    if (!agent) {
      this.logger.log(
        `feature ${slug} went in progress with no agent working in ${project.name}; no run recorded`,
      );
      return;
    }
    const range = this.features.range(projectId, slug)[feature.repo];
    const base = range?.base ?? (repo ? await head(repo.path) : null);
    const status = this.agents.status(agent.id);
    this.db
      .prepare(
        `INSERT INTO runs (id, project_id, project_name, host, repo, slug, agent_id, agent_name,
           profile, model, effort, permissions, started_at, base_commit, item_from, start_spend)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        projectId,
        project.name,
        this.config.hostName,
        feature.repo,
        slug,
        agent.id,
        agent.name,
        agent.profile,
        agent.model,
        agent.effort,
        agent.permissions,
        Date.now(),
        base,
        this.agents.itemCount(agent.id),
        JSON.stringify(spendOf(status.usage)),
      );
  }

  private async closeForFeature(
    projectId: string,
    slug: string,
    status: FeatureStatus,
  ): Promise<void> {
    const row = this.db
      .prepare(
        'SELECT * FROM runs WHERE project_id = ? AND slug = ? AND ended_at IS NULL',
      )
      .get(projectId, slug) as RunRow | undefined;
    if (row) await this.close(row, 'feature', status);
  }

  private async closeForAgent(
    agentId: string,
    outcome: RunOutcome,
  ): Promise<void> {
    const rows = this.db
      .prepare('SELECT * FROM runs WHERE agent_id = ? AND ended_at IS NULL')
      .all(agentId) as RunRow[];
    for (const row of rows) await this.close(row, outcome, null);
  }

  /**
   * Ends a run: the repository's HEAD now, what the vendor says the work
   * cost since the run began, the agent's report, and the transcript of
   * the window exported to a file of its own so it survives the agent.
   */
  private async close(
    row: RunRow,
    outcome: RunOutcome,
    featureStatus: FeatureStatus | null,
  ): Promise<void> {
    if (this.closing.has(row.id)) return;
    this.closing.add(row.id);
    try {
      const fresh = this.db
        .prepare('SELECT ended_at FROM runs WHERE id = ?')
        .get(row.id) as { ended_at: number | null } | undefined;
      if (!fresh || fresh.ended_at !== null) return; // closed while we waited
      let endCommit: string | null = null;
      let status = featureStatus;
      let report: string | null = null;
      try {
        const project = this.projects.get(row.project_id);
        const repo = project.repos.find((r) => r.name === row.repo);
        if (repo) {
          endCommit = await head(repo.path);
          const file = await readFeature(repo, row.slug);
          if (file) {
            status ??= file.status;
            report = lastReport(file.body);
          }
        }
      } catch {
        // the project is gone; the run keeps what it recorded at its start
      }
      const spend = this.spendSince(row);
      const itemTo = this.itemCountOf(row.agent_id);
      const file = await this.exportTranscript(row, itemTo);
      this.db
        .prepare(
          `UPDATE runs SET ended_at = ?, outcome = ?, feature_status = ?, end_commit = ?,
             turns = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?,
             item_to = ?, report = ?, transcript_file = ? WHERE id = ?`,
        )
        .run(
          Date.now(),
          outcome,
          status,
          endCommit,
          spend.turns,
          spend.inputTokens,
          spend.outputTokens,
          spend.costUsd,
          itemTo,
          report,
          file,
          row.id,
        );
    } finally {
      this.closing.delete(row.id);
    }
  }

  /**
   * What the run cost: the vendor's running totals now less what they were
   * when it began. Null, not zero, when the vendor has said nothing during
   * the run — "no data" and "free" are different things.
   */
  private spendSince(row: RunRow): RunSpend {
    const none: RunSpend = {
      turns: null,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    };
    let now: ReturnType<typeof spendOf>;
    try {
      now = spendOf(this.agents.status(row.agent_id).usage);
    } catch {
      return none; // the agent is already gone
    }
    if (!now) return none;
    const start = row.start_spend
      ? (JSON.parse(row.start_spend) as ReturnType<typeof spendOf>)
      : null;
    return {
      turns: now.turns - (start?.turns ?? 0),
      inputTokens: now.inputTokens - (start?.inputTokens ?? 0),
      outputTokens: now.outputTokens - (start?.outputTokens ?? 0),
      costUsd:
        now.costUsd === null
          ? null
          : Math.round((now.costUsd - (start?.costUsd ?? 0)) * 1e6) / 1e6,
    };
  }

  private itemCountOf(agentId: string): number | null {
    try {
      return this.agents.itemCount(agentId);
    } catch {
      return null;
    }
  }

  /**
   * The transcript items of the run's window, NDJSON, one file per run
   * under `<dataDir>/runs/`. Written while the agent is still there (the
   * before-remove hook), and kept indefinitely: outliving the agent is the
   * whole point of the log.
   */
  private async exportTranscript(
    row: RunRow,
    itemTo: number | null,
  ): Promise<string | null> {
    if (itemTo === null || itemTo <= row.item_from) return null;
    try {
      const { items } = await this.agents.items(row.agent_id, {
        from: row.item_from,
      });
      const mine = items.filter((i) => i.index < itemTo);
      if (!mine.length) return null;
      await fs.mkdir(this.transcriptDir, { recursive: true });
      const name = `${row.id}.ndjson`;
      const target = path.join(this.transcriptDir, name);
      const tmp = `${target}.${process.pid}.tmp`;
      await fs.writeFile(
        tmp,
        mine.map((i) => `${JSON.stringify(i)}\n`).join(''),
      );
      await fs.rename(tmp, target);
      return name;
    } catch (err) {
      this.logger.warn(
        `run ${row.id}: transcript not exported: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Open runs whose agent has gone quiet for `runIdleMs` are abandoned,
   * and open runs whose agent is gone altogether (forgotten while the
   * manager was down) are closed as such.
   */
  private async sweep(): Promise<void> {
    const rows = this.db
      .prepare('SELECT * FROM runs WHERE ended_at IS NULL')
      .all() as RunRow[];
    for (const row of rows) {
      let last: number;
      try {
        last = this.agents.status(row.agent_id).lastActivityAt;
      } catch {
        await this.close(row, 'agent-removed', null);
        continue;
      }
      if (
        this.config.runIdleMs > 0 &&
        Date.now() - last > this.config.runIdleMs
      )
        await this.close(row, 'abandoned', null);
    }
  }
}

/** The vendor's running totals for the agent, across its sessions; null when it has said nothing. */
function spendOf(usage: { total?: Spendish; spend?: Spendish } | null): {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
} | null {
  const s = usage?.total ?? usage?.spend;
  if (!s) return null;
  return {
    turns: s.turns,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    costUsd: s.costUsd ?? null,
  };
}

interface Spendish {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

function toRun(r: RunRow): Run {
  return {
    id: r.id,
    projectId: r.project_id,
    projectName: r.project_name,
    host: r.host,
    repo: r.repo,
    slug: r.slug,
    agentId: r.agent_id,
    agentName: r.agent_name,
    profile: r.profile,
    model: r.model,
    effort: r.effort,
    permissions: r.permissions,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    featureStatus: (r.feature_status as FeatureStatus | null) ?? null,
    outcome: (r.outcome as RunOutcome | null) ?? null,
    baseCommit: r.base_commit,
    endCommit: r.end_commit,
    turns: r.turns,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: r.cost_usd,
    itemFrom: r.item_from,
    itemTo: r.item_to,
    report: r.report,
  };
}
