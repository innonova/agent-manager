import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { DbService } from '../db/db.service.js';
import { ProjectsService, Repo } from '../projects/projects.service.js';
import { head } from '../changes/git.js';
import { ReadCursorsService } from '../changes/read-cursors.service.js';
import {
  FEATURE_STATUSES,
  FeatureFile,
  FeatureStatus,
  isSlug,
  createFeatureFile,
  modifyFeature,
  readFeature,
  readFeatures,
} from './feature-file.js';

export type Feature = Omit<FeatureFile, 'extra'> & {
  /** Per repository, the commits the work spans: recorded at in-progress and at done. */
  range: Record<string, { base: string; end: string | null }> | null;
};

interface Found {
  file: FeatureFile;
  repoPath: string;
}

/** The statuses a human sets through the API; `in-progress` is the agent's. */
const HUMAN_STATUSES: FeatureStatus[] = [
  'planned',
  'review',
  'blocked',
  'done',
];

/** How often feature files are re-read to notice edits made by agents or by hand. */
const POLL_MS = 3000;

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Features are markdown files under `features/` in any of the project's
 * repositories: a spec, followed by the conversation about it (`## Report`
 * sections written by the agent, `## Response` sections by the human).
 * Nothing here queues or starts work: a human asks an agent in its
 * conversation, and the agent edits the file itself. The manager reads the
 * files, writes what the human asks (create, respond, set a status) and
 * polls for changes so the UI stays current.
 */
@Injectable()
export class FeaturesService
  extends EventEmitter<{ changed: [projectId: string, feature: Feature] }>
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(FeaturesService.name);
  private timer: NodeJS.Timeout | null = null;
  /** project id -> slug -> mtime as last announced, so the poller announces only edits. */
  private seen = new Map<string, Map<string, number>>();
  /** "project/slug" -> status last seen, to notice transitions made by editing the file. */
  private lastStatus = new Map<string, FeatureStatus>();
  /** One poll at a time; a slow one is simply not overlapped. */
  private polling = false;
  /**
   * Called after a feature's status changed and its commit range was
   * recorded, before the change is announced. A hook rather than a
   * dependency so that what reacts to a transition (the run log) can
   * depend on features without features depending on it.
   */
  private transitions: ((
    projectId: string,
    slug: string,
    was: FeatureStatus | null,
    now: FeatureStatus,
  ) => Promise<void>)[] = [];

  onTransition(
    fn: (
      projectId: string,
      slug: string,
      was: FeatureStatus | null,
      now: FeatureStatus,
    ) => Promise<void>,
  ): void {
    this.transitions.push(fn);
  }

  /** The range first, then whoever watches transitions; failures there never fail the write. */
  private async transition(
    projectId: string,
    slug: string,
    was: FeatureStatus | null,
    now: FeatureStatus,
  ): Promise<void> {
    await this.recordRange(projectId, slug, now);
    for (const fn of this.transitions)
      await fn(projectId, slug, was, now).catch((err: Error) =>
        this.logger.warn(
          `feature ${slug}: transition hook failed: ${err.message}`,
        ),
      );
  }
  /**
   * Writes to one feature file are serialised, and each one re-reads the
   * file right before writing, so a human's status change or response
   * never overwrites a report the agent appended meanwhile.
   */
  private writes = new Map<string, Promise<unknown>>();

  private async serialised<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.writes.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.writes.set(key, next);
    try {
      return await next;
    } finally {
      if (this.writes.get(key) === next) this.writes.delete(key);
    }
  }

  constructor(
    private readonly dbs: DbService,
    private readonly projects: ProjectsService,
    private readonly cursors: ReadCursorsService,
  ) {
    super();
  }

  private get db() {
    return this.dbs.db;
  }

  onModuleInit(): void {
    this.timer = setInterval(
      () =>
        void this.poll().catch((err: Error) =>
          this.logger.warn(`feature poll failed: ${err.message}`),
        ),
      POLL_MS,
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- reading --------------------------------------------------------------

  /** Every repo's features; a slug present in two repos keeps the first (the primary wins) and is logged. */
  private async readAll(repos: Repo[]): Promise<FeatureFile[]> {
    const seen = new Map<string, FeatureFile>();
    for (const repo of repos) {
      for (const f of await readFeatures(repo)) {
        const first = seen.get(f.slug);
        if (first) {
          this.logger.warn(
            `feature slug ${f.slug} exists in both ${first.repo} and ${repo.name}; using ${first.repo}`,
          );
          continue;
        }
        seen.set(f.slug, f);
      }
    }
    return [...seen.values()];
  }

  private async repoHolding(repos: Repo[], slug: string): Promise<Repo | null> {
    if (!isSlug(slug)) return null;
    for (const repo of repos) if (await readFeature(repo, slug)) return repo;
    return null;
  }

  private async readOne(repos: Repo[], slug: string): Promise<Found | null> {
    if (!isSlug(slug)) return null;
    for (const repo of repos) {
      const file = await readFeature(repo, slug);
      if (file) return { file, repoPath: repo.path };
    }
    return null;
  }

  async list(projectId: string): Promise<Feature[]> {
    const project = this.projects.get(projectId);
    const features = (await this.readAll(project.repos)).map((f) =>
      this.decorate(projectId, f),
    );
    const order: Record<FeatureStatus, number> = {
      'in-progress': 0,
      review: 1,
      blocked: 2,
      planned: 3,
      done: 4,
    };
    // Done features are history: newest first, by the file's last write,
    // which is the moment it was marked done. Everything else is a queue:
    // priority, then name.
    return features.sort(
      (a, b) =>
        order[a.status] - order[b.status] ||
        (a.status === 'done'
          ? b.mtime - a.mtime
          : a.priority - b.priority || a.slug.localeCompare(b.slug)),
    );
  }

  async get(projectId: string, slug: string): Promise<Feature> {
    const project = this.projects.get(projectId);
    const found = await this.readOne(project.repos, slug);
    if (!found) throw new NotFoundException(`no feature ${slug}`);
    return this.decorate(projectId, found.file);
  }

  /** The commits a feature's work spans, per repository; empty when nothing was recorded. */
  range(
    projectId: string,
    slug: string,
  ): Record<string, { base: string; end: string | null }> {
    const rows = this.db
      .prepare(
        'SELECT repo, base_commit, end_commit FROM feature_ranges WHERE project_id = ? AND slug = ?',
      )
      .all(projectId, slug) as {
      repo: string;
      base_commit: string;
      end_commit: string | null;
    }[];
    const out: Record<string, { base: string; end: string | null }> =
      Object.create(null);
    for (const r of rows)
      out[r.repo] = { base: r.base_commit, end: r.end_commit };
    return out;
  }

  private decorate(projectId: string, f: FeatureFile): Feature {
    const range = this.range(projectId, f.slug);
    return { ...strip(f), range: Object.keys(range).length ? range : null };
  }

  /** At first sight only: a range for each repository that has none; existing rows are never touched. */
  private async backfillRange(
    projectId: string,
    slug: string,
    status: 'in-progress' | 'done',
  ): Promise<void> {
    const project = this.projects.get(projectId);
    const have = this.range(projectId, slug);
    for (const repo of project.repos) {
      if (Object.hasOwn(have, repo.name)) continue;
      const h = await head(repo.path);
      if (!h) continue;
      this.db
        .prepare(
          'INSERT OR IGNORE INTO feature_ranges (project_id, slug, repo, base_commit, end_commit) VALUES (?, ?, ?, ?, ?)',
        )
        .run(projectId, slug, repo.name, h, status === 'done' ? h : null);
    }
  }

  /**
   * Bookends for the diff view. The base is HEAD of each repository when
   * the feature first goes in progress (the agent sets that status; the
   * poller notices within seconds, before any commit of the work); the end
   * is HEAD when it is marked done. Later rounds keep the first base, so a
   * feature's range covers all its rounds.
   */
  private async recordRange(
    projectId: string,
    slug: string,
    status: FeatureStatus,
  ): Promise<void> {
    if (status !== 'in-progress' && status !== 'done') return;
    const project = this.projects.get(projectId);
    for (const repo of project.repos) {
      const h = await head(repo.path);
      if (!h) continue;
      if (status === 'in-progress')
        this.db
          .prepare(
            'INSERT OR IGNORE INTO feature_ranges (project_id, slug, repo, base_commit) VALUES (?, ?, ?, ?)',
          )
          .run(projectId, slug, repo.name, h);
      else {
        const r = this.db
          .prepare(
            'UPDATE feature_ranges SET end_commit = ? WHERE project_id = ? AND slug = ? AND repo = ?',
          )
          .run(h, projectId, slug, repo.name);
        // never seen in progress (done by hand, or before the manager watched): an empty range at HEAD
        if (r.changes === 0)
          this.db
            .prepare(
              'INSERT OR IGNORE INTO feature_ranges (project_id, slug, repo, base_commit, end_commit) VALUES (?, ?, ?, ?, ?)',
            )
            .run(projectId, slug, repo.name, h, h);
      }
    }
  }

  /**
   * Agents and humans edit feature files directly; this turns those edits
   * into `changed` events. The files are few and small, so re-reading them
   * every few seconds costs nothing and needs no watcher lifecycle tied to
   * projects coming and going.
   */
  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const projectIds = new Set<string>();
      for (const project of this.projects.list()) {
        projectIds.add(project.id);
        const known = this.seen.get(project.id);
        const files = await this.readAll(project.repos);
        const next = new Map<string, number>();
        for (const f of files) {
          next.set(f.slug, f.mtime);
          const key = `${project.id}/${f.slug}`;
          if (!known) {
            // First sight (startup): a feature already in progress with no
            // base recorded gets one now, and one already done gets an
            // empty range; HEAD now is the best evidence there is, the
            // true start was before the manager was watching.
            if (f.status === 'in-progress' || f.status === 'done')
              await this.backfillRange(project.id, f.slug, f.status);
          } else if (known.get(f.slug) !== f.mtime) {
            const was = this.lastStatus.get(key);
            if (was !== f.status)
              await this.transition(project.id, f.slug, was ?? null, f.status);
            this.emit('changed', project.id, this.decorate(project.id, f));
          }
          this.lastStatus.set(key, f.status);
        }
        this.seen.set(project.id, next);
        // forget bookkeeping for files that are gone
        for (const k of this.lastStatus.keys())
          if (
            k.startsWith(`${project.id}/`) &&
            !next.has(k.slice(project.id.length + 1))
          )
            this.lastStatus.delete(k);
      }
      for (const id of this.seen.keys())
        if (!projectIds.has(id)) this.seen.delete(id);
    } finally {
      this.polling = false;
    }
  }

  /** Announces a feature the manager itself just wrote, and remembers its mtime so the poller does not repeat it. */
  private announce(projectId: string, feature: Feature): void {
    let known = this.seen.get(projectId);
    if (!known) this.seen.set(projectId, (known = new Map()));
    known.set(feature.slug, feature.mtime);
    this.lastStatus.set(`${projectId}/${feature.slug}`, feature.status);
    this.emit('changed', projectId, feature);
  }

  /** After a human write: bookend the range if the status moved, then re-read and announce. */
  private async finish(
    projectId: string,
    slug: string,
    before: FeatureStatus,
    after: FeatureStatus,
    userId?: string,
  ): Promise<Feature> {
    if (before !== after) await this.transition(projectId, slug, before, after);
    // Done means the human has looked at the work: their "since I last
    // looked" cursor moves to now in every repository of the project.
    if (before !== after && after === 'done' && userId)
      await this.cursors.markRead(userId, projectId);
    const feature = await this.get(projectId, slug);
    this.announce(projectId, feature);
    return feature;
  }

  // ---- the human's writes ---------------------------------------------------

  async create(
    projectId: string,
    input: {
      slug?: unknown;
      title?: unknown;
      body?: unknown;
      priority?: unknown;
      dependsOn?: unknown;
      repo?: unknown;
    },
  ): Promise<Feature> {
    const project = this.projects.get(projectId);
    if (!isSlug(input.slug))
      throw new BadRequestException(
        '"slug" must be lowercase letters, digits, dot, dash or underscore',
      );
    if (typeof input.title !== 'string' || !input.title.trim())
      throw new BadRequestException('"title" is required');
    if (input.body !== undefined && typeof input.body !== 'string')
      throw new BadRequestException('"body" must be a string');
    const priority =
      input.priority === undefined ? 100 : Number(input.priority);
    if (!Number.isFinite(priority))
      throw new BadRequestException('"priority" must be a number');
    const dependsOn =
      input.dependsOn === undefined
        ? []
        : Array.isArray(input.dependsOn) && input.dependsOn.every(isSlug)
          ? input.dependsOn
          : null;
    if (!dependsOn)
      throw new BadRequestException('"dependsOn" must be a list of slugs');
    const repo =
      input.repo === undefined || input.repo === null || input.repo === ''
        ? project.repos[0]
        : this.projects.repoOf(project, String(input.repo));
    if (!repo)
      throw new BadRequestException(
        `"repo" must name one of the project's repos: ${project.repos.map((r) => r.name).join(', ')}`,
      );
    const slug = input.slug;
    const title = input.title.trim();
    return this.serialised(`${projectId}/${slug}`, async () => {
      if (await this.readOne(project.repos, slug))
        throw new ConflictException(`feature ${slug} already exists`);
      const f: FeatureFile = {
        slug,
        repo: repo.name,
        path: `${repo.name}/features/${slug}.md`,
        title,
        status: 'planned',
        priority,
        dependsOn,
        body: (input.body as string | undefined) ?? '',
        extra: {},
        mtime: Date.now(),
      };
      try {
        await createFeatureFile(repo.path, f);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST')
          throw new ConflictException(`feature ${slug} already exists`);
        throw err;
      }
      const feature = await this.get(projectId, f.slug);
      this.announce(projectId, feature);
      return feature;
    });
  }

  /**
   * The human's edits: any of status, title, body, priority and dependsOn.
   * `in-progress` is the agent's status and is refused. Content can be
   * edited at any time (the UI offers it for planned features, i.e. before
   * or between rounds of work); the body is the whole file below the
   * frontmatter, reports and responses included.
   */
  async update(
    projectId: string,
    slug: string,
    input: {
      status?: unknown;
      title?: unknown;
      body?: unknown;
      priority?: unknown;
      dependsOn?: unknown;
    },
    userId?: string,
  ): Promise<Feature> {
    const project = this.projects.get(projectId);
    if (
      input.status !== undefined &&
      !HUMAN_STATUSES.includes(input.status as FeatureStatus)
    )
      throw new BadRequestException(
        `"status" must be one of ${HUMAN_STATUSES.join(', ')}`,
      );
    if (
      input.title !== undefined &&
      (typeof input.title !== 'string' || !input.title.trim())
    )
      throw new BadRequestException('"title" must be a non-empty string');
    if (input.body !== undefined && typeof input.body !== 'string')
      throw new BadRequestException('"body" must be a string');
    if (
      input.priority !== undefined &&
      !Number.isFinite(Number(input.priority))
    )
      throw new BadRequestException('"priority" must be a number');
    if (
      input.dependsOn !== undefined &&
      !(Array.isArray(input.dependsOn) && input.dependsOn.every(isSlug))
    )
      throw new BadRequestException('"dependsOn" must be a list of slugs');
    if (
      input.status === undefined &&
      input.title === undefined &&
      input.body === undefined &&
      input.priority === undefined &&
      input.dependsOn === undefined
    )
      throw new BadRequestException('nothing to change');
    return this.serialised(`${projectId}/${slug}`, async () => {
      const repo = await this.repoHolding(project.repos, slug);
      if (!repo) throw new NotFoundException(`no feature ${slug}`);
      let before: FeatureStatus | null = null;
      const written = await modifyFeature(repo, slug, (f) => {
        before ??= f.status;
        if (input.status !== undefined)
          f.status = input.status as FeatureStatus;
        if (input.title !== undefined) f.title = (input.title as string).trim();
        if (input.body !== undefined) f.body = input.body as string;
        if (input.priority !== undefined) f.priority = Number(input.priority);
        if (input.dependsOn !== undefined)
          f.dependsOn = input.dependsOn as string[];
        return f;
      });
      if (!written) throw new NotFoundException(`no feature ${slug}`);
      return this.finish(projectId, slug, before!, written.status, userId);
    });
  }

  /**
   * Appends the human's answer to the agent's report as a dated
   * `## Response` section and sets the status, `planned` by default so the
   * next time an agent is asked to work on the feature it picks it up with
   * the answer in front of it.
   */
  async respond(
    projectId: string,
    slug: string,
    input: { text?: unknown; status?: unknown },
    by?: string,
    userId?: string,
  ): Promise<Feature> {
    const project = this.projects.get(projectId);
    if (typeof input.text !== 'string' || !input.text.trim())
      throw new BadRequestException('"text" is required');
    const text = input.text.trim();
    const status = input.status === undefined ? 'planned' : input.status;
    if (!HUMAN_STATUSES.includes(status as FeatureStatus))
      throw new BadRequestException(
        `"status" must be one of ${HUMAN_STATUSES.join(', ')}`,
      );
    return this.serialised(`${projectId}/${slug}`, async () => {
      const repo = await this.repoHolding(project.repos, slug);
      if (!repo) throw new NotFoundException(`no feature ${slug}`);
      let before: FeatureStatus | null = null;
      const heading = by ? `${today()}, ${by}` : today();
      const written = await modifyFeature(repo, slug, (f) => {
        before ??= f.status;
        f.body = `${f.body.replace(/\s+$/, '')}\n\n## Response (${heading})\n\n${text}\n`;
        f.status = status as FeatureStatus;
        return f;
      });
      if (!written) throw new NotFoundException(`no feature ${slug}`);
      return this.finish(projectId, slug, before!, written.status, userId);
    });
  }
}

function strip(f: FeatureFile): Omit<Feature, 'range'> {
  const { extra: _extra, ...rest } = f;
  return rest;
}

export { FEATURE_STATUSES };
