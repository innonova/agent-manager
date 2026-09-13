import fs from 'node:fs/promises';
import path from 'node:path';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import { MAX_FILE_BYTES } from '../files/files.service.js';
import { FeaturesService } from '../features/features.service.js';
import { ProjectsService, Repo } from '../projects/projects.service.js';
import { isSlug } from '../features/feature-file.js';
import { changedFiles, head, resolveCommit, showAt } from './git.js';
import { ReadCursorsService } from './read-cursors.service.js';
import type { ChangedFile } from './git.js';

export interface RepoChanges {
  repo: string;
  /** The commit the changes are measured from; null when there is none (not a repository). */
  base: string | null;
  head: string | null;
  /** Why the base is not what was asked for, if it is not. */
  note: string | null;
  files: (ChangedFile & { path: string })[];
}

export interface FileDiff {
  path: string;
  base: string | null;
  /** Content at the base, null if the file did not exist there. */
  before: string | null;
  /** Working-tree content, null if the file is gone. */
  after: string | null;
  binary: boolean;
  truncated: boolean;
}

/**
 * What changed in a project's repositories since a base: the caller's read
 * cursor (`read`, the default), a feature's recorded range
 * (`feature:<slug>`), or any commit-ish. Always measured against the
 * working tree, so uncommitted work shows too. Read-only; the tree is
 * never touched, so an agent mid-turn is no concern beyond staleness.
 */
@Injectable()
export class ChangesService {
  constructor(
    private readonly dbs: DbService,
    private readonly projects: ProjectsService,
    private readonly features: FeaturesService,
    private readonly cursors: ReadCursorsService,
  ) {}

  private get db() {
    return this.dbs.db;
  }

  /** Resolves the base spec to a commit per repository, with a note when it had to fall back. */
  private async baseFor(
    userId: string,
    projectId: string,
    repo: Repo,
    spec: string,
  ): Promise<{
    base: string | null;
    head: string | null;
    note: string | null;
  }> {
    const h = await head(repo.path);
    if (!h) return { base: null, head: null, note: 'not a git repository' };
    if (spec === 'read') {
      const cursor = this.cursors.get(userId, projectId, repo.name);
      if (!cursor)
        return {
          base: h,
          head: h,
          note: 'nothing marked read yet; showing uncommitted changes',
        };
      const ok = await resolveCommit(repo.path, cursor);
      return ok
        ? { base: ok, head: h, note: null }
        : {
            base: h,
            head: h,
            note: 'the last read commit no longer exists (history rewritten); showing uncommitted changes',
          };
    }
    if (spec.startsWith('feature:')) {
      const slug = spec.slice('feature:'.length);
      if (!isSlug(slug)) throw new BadRequestException('bad feature slug');
      const range = this.features.range(projectId, slug)[repo.name];
      if (!range)
        return {
          base: h,
          head: h,
          note: 'no range recorded for this feature here; showing uncommitted changes',
        };
      const ok = await resolveCommit(repo.path, range.base);
      if (!ok)
        return {
          base: h,
          head: h,
          note: 'the feature’s base commit no longer exists (history rewritten); showing uncommitted changes',
        };
      return {
        base: ok,
        head: h,
        note: range.end
          ? `feature ended at ${range.end.slice(0, 8)}; later changes show too`
          : null,
      };
    }
    const ok = await resolveCommit(repo.path, spec);
    if (!ok) throw new BadRequestException(`unknown base: ${spec}`);
    return { base: ok, head: h, note: null };
  }

  async list(
    userId: string,
    projectId: string,
    spec = 'read',
  ): Promise<{ base: string; repos: RepoChanges[] }> {
    const project = this.projects.get(projectId);
    const repos: RepoChanges[] = [];
    for (const repo of project.repos) {
      const b = await this.baseFor(userId, projectId, repo, spec);
      const files = b.base
        ? ((await changedFiles(repo.path, b.base)) ?? [])
        : [];
      repos.push({
        repo: repo.name,
        base: b.base,
        head: b.head,
        note: b.note,
        files: files.map((f) => ({
          ...f,
          path: `${repo.name}/${f.path}`,
          ...(f.oldPath ? { oldPath: `${repo.name}/${f.oldPath}` } : {}),
        })),
      });
    }
    return { base: spec, repos };
  }

  async file(
    userId: string,
    projectId: string,
    rel: unknown,
    spec = 'read',
  ): Promise<FileDiff> {
    const project = this.projects.get(projectId);
    if (typeof rel !== 'string' || !rel || rel.includes('..'))
      throw new BadRequestException('"path" is required');
    const [repoName, ...rest] = rel.split('/');
    const repo = project.repos.find((r) => r.name === repoName);
    if (!repo || rest.length === 0)
      throw new NotFoundException(`no such file: ${rel}`);
    const inRepo = rest.join('/');
    const b = await this.baseFor(userId, projectId, repo, spec);
    const beforeBuf = b.base ? await showAt(repo.path, b.base, inRepo) : null;
    let afterBuf: Buffer | null = null;
    try {
      afterBuf = await fs.readFile(path.join(repo.path, ...rest));
    } catch {
      afterBuf = null;
    }
    const size = Math.max(beforeBuf?.length ?? 0, afterBuf?.length ?? 0);
    const binary = [beforeBuf, afterBuf].some((buf) =>
      buf?.subarray(0, 8192).includes(0),
    );
    if (size > MAX_FILE_BYTES || binary)
      return {
        path: rel,
        base: b.base,
        before: null,
        after: null,
        binary,
        truncated: size > MAX_FILE_BYTES,
      };
    return {
      path: rel,
      base: b.base,
      before: beforeBuf ? beforeBuf.toString('utf8') : null,
      after: afterBuf ? afterBuf.toString('utf8') : null,
      binary: false,
      truncated: false,
    };
  }

  /** Marks everything up to HEAD as read for this user, in one repository or all. */
  async markRead(
    userId: string,
    projectId: string,
    repoName?: unknown,
  ): Promise<{ repos: { repo: string; commit: string }[] }> {
    const project = this.projects.get(projectId);
    if (repoName !== undefined && typeof repoName !== 'string')
      throw new BadRequestException('"repo" must be a string');
    if (repoName && !project.repos.some((r) => r.name === repoName))
      throw new NotFoundException(`no such repository: ${repoName}`);
    return { repos: await this.cursors.markRead(userId, projectId, repoName) };
  }
}
