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
  readFeature,
  readFeatures,
  writeFeature,
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
    return features.sort(
      (a, b) =>
        order[a.status] - order[b.status] ||
        a.priority - b.priority ||
        a.slug.localeCompare(b.slug),
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
    const out: Record<string, { base: string; end: string | null }> = {};
    for (const r of rows)
      out[r.repo] = { base: r.base_commit, end: r.end_commit };
    return out;
  }

  private decorate(projectId: string, f: FeatureFile): Feature {
    const range = this.range(projectId, f.slug);
    return { ...strip(f), range: Object.keys(range).length ? range : null };
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
      else
        this.db
          .prepare(
            'UPDATE feature_ranges SET end_commit = ? WHERE project_id = ? AND slug = ? AND repo = ?',
          )
          .run(h, projectId, slug, repo.name);
    }
  }

  /**
   * Agents and humans edit feature files directly; this turns those edits
   * into `changed` events. The files are few and small, so re-reading them
   * every few seconds costs nothing and needs no watcher lifecycle tied to
   * projects coming and going.
   */
  private async poll(): Promise<void> {
    for (const project of this.projects.list()) {
      const known = this.seen.get(project.id);
      const files = await this.readAll(project.repos);
      const next = new Map<string, number>();
      for (const f of files) {
        next.set(f.slug, f.mtime);
        // The first pass only records what is there.
        if (known && known.get(f.slug) !== f.mtime) {
          const was = this.lastStatus.get(`${project.id}/${f.slug}`);
          if (was !== f.status)
            await this.recordRange(project.id, f.slug, f.status);
          this.emit('changed', project.id, this.decorate(project.id, f));
        }
        this.lastStatus.set(`${project.id}/${f.slug}`, f.status);
      }
      this.seen.set(project.id, next);
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
    if (before !== after) await this.recordRange(projectId, slug, after);
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
    if (await this.readOne(project.repos, input.slug))
      throw new ConflictException(`feature ${input.slug} already exists`);
    const f: FeatureFile = {
      slug: input.slug,
      repo: repo.name,
      path: `${repo.name}/features/${input.slug}.md`,
      title: input.title.trim(),
      status: 'planned',
      priority,
      dependsOn,
      body: (input.body as string | undefined) ?? '',
      extra: {},
      mtime: Date.now(),
    };
    await writeFeature(repo.path, f);
    const feature = await this.get(projectId, f.slug);
    this.announce(projectId, feature);
    return feature;
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
    const found = await this.readOne(project.repos, slug);
    if (!found) throw new NotFoundException(`no feature ${slug}`);
    const f = found.file;
    const before = f.status;
    if (input.status !== undefined) f.status = input.status as FeatureStatus;
    if (input.title !== undefined) f.title = (input.title as string).trim();
    if (input.body !== undefined) f.body = input.body as string;
    if (input.priority !== undefined) f.priority = Number(input.priority);
    if (input.dependsOn !== undefined)
      f.dependsOn = input.dependsOn as string[];
    await writeFeature(found.repoPath, f);
    return this.finish(projectId, slug, before, f.status, userId);
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
    const status = input.status === undefined ? 'planned' : input.status;
    if (!HUMAN_STATUSES.includes(status as FeatureStatus))
      throw new BadRequestException(
        `"status" must be one of ${HUMAN_STATUSES.join(', ')}`,
      );
    const found = await this.readOne(project.repos, slug);
    if (!found) throw new NotFoundException(`no feature ${slug}`);
    const f = found.file;
    const before = f.status;
    const heading = by ? `${today()}, ${by}` : today();
    f.body = `${f.body.replace(/\s+$/, '')}\n\n## Response (${heading})\n\n${input.text.trim()}\n`;
    f.status = status as FeatureStatus;
    await writeFeature(found.repoPath, f);
    return this.finish(projectId, slug, before, f.status, userId);
  }
}

function strip(f: FeatureFile): Omit<Feature, 'range'> {
  const { extra: _extra, ...rest } = f;
  return rest;
}

export { FEATURE_STATUSES };
