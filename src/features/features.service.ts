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
import { ProjectsService, Repo } from '../projects/projects.service.js';
import {
  FEATURE_STATUSES,
  FeatureFile,
  FeatureStatus,
  isSlug,
  readFeature,
  readFeatures,
  writeFeature,
} from './feature-file.js';

export type Feature = Omit<FeatureFile, 'extra'>;

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

  constructor(private readonly projects: ProjectsService) {
    super();
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
    const features = (await this.readAll(project.repos)).map(strip);
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
    return strip(found.file);
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
        if (known && known.get(f.slug) !== f.mtime)
          this.emit('changed', project.id, strip(f));
      }
      this.seen.set(project.id, next);
    }
  }

  /** Announces a feature the manager itself just wrote, and remembers its mtime so the poller does not repeat it. */
  private announce(projectId: string, feature: Feature): void {
    let known = this.seen.get(projectId);
    if (!known) this.seen.set(projectId, (known = new Map()));
    known.set(feature.slug, feature.mtime);
    this.emit('changed', projectId, feature);
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

  /** The human's transitions: anything but `in-progress`, which the agent sets. */
  async setStatus(
    projectId: string,
    slug: string,
    status: unknown,
  ): Promise<Feature> {
    const project = this.projects.get(projectId);
    if (!HUMAN_STATUSES.includes(status as FeatureStatus))
      throw new BadRequestException(
        `"status" must be one of ${HUMAN_STATUSES.join(', ')}`,
      );
    const found = await this.readOne(project.repos, slug);
    if (!found) throw new NotFoundException(`no feature ${slug}`);
    found.file.status = status as FeatureStatus;
    await writeFeature(found.repoPath, found.file);
    const feature = await this.get(projectId, slug);
    this.announce(projectId, feature);
    return feature;
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
    f.body = `${f.body.replace(/\s+$/, '')}\n\n## Response (${today()})\n\n${input.text.trim()}\n`;
    f.status = status as FeatureStatus;
    await writeFeature(found.repoPath, f);
    const feature = await this.get(projectId, slug);
    this.announce(projectId, feature);
    return feature;
  }
}

function strip(f: FeatureFile): Feature {
  const { extra: _extra, ...rest } = f;
  return rest;
}

export { FEATURE_STATUSES };
