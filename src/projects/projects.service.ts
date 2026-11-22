import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DbService } from '../db/db.service.js';
import { MANAGER_CONFIG } from '../config/config.js';
import type { ManagerConfig } from '../config/config.js';
import { workspacePath, writeWorkspace } from './workspace.js';
import {
  clonesIn,
  FOLDER_LINK,
  streamFolder,
  STREAM_NAME_RE,
} from '../streams/streams.js';

export interface Repo {
  name: string;
  path: string;
  /** A stream's own folder in the store, standing where a repository stands: files to read and features to keep, but not a repository of its own (its commits are the store's, made by the manager). */
  folder?: true;
}

/**
 * The repositories whose commits are the project's work: all of a
 * project's, and a stream's clones. Not a stream's folder: its commits
 * are the store's, made by the manager for every stream at once.
 */
export function codeRepos(project: Project): Repo[] {
  return project.repos.filter((r) => !r.folder);
}

/**
 * Where a project's features are read and written: its repositories, or
 * for a stream its own folder and nothing else. A stream's clones have
 * `features/` directories of their own, and those are other work's.
 */
export function featureRepos(project: Project): Repo[] {
  return project.kind === 'stream'
    ? project.repos.filter((r) => r.folder)
    : project.repos;
}

/** When an agent in the project may start another: on its own judgement (`free`), or only when a person asked (`on-request`). */
export type Delegation = 'free' | 'on-request';

export interface Project {
  id: string;
  name: string;
  /**
   * A list of repositories on this machine (`project`), or a unit of
   * work with a home of its own that clones what it needs (`stream`;
   * see `docs/streams.md`). The same thing to everything that deals
   * with agents; different in where an agent starts and what `repos` is.
   */
  kind: 'project' | 'stream';
  /** The label a tree shows it under, so many streams need not be one flat list; null is ungrouped. A way to find things, nothing more: no setting and no permission follows from it. */
  group: string | null;
  /** The primary repo's path, or a stream's home: where an agent starts unless told otherwise. */
  path: string;
  /** A project's repositories as registered; a stream's own folder (named `stream`) and then whatever clones are in its home right now. */
  repos: Repo[];
  defaultProfile: string | null;
  delegation: Delegation;
  createdAt: number;
  /** The VS Code workspace file the manager keeps beside the repositories (see `workspace.ts`). */
  workspace: string;
  /**
   * A stream that is put away, or on its way there or back (see
   * `ArchiveService`); null for everything that is simply there. While
   * it is set, the stream's agents take no turns and it gets no new
   * agents or clones.
   */
  archive: { state: ArchiveState; at: number } | null;
}

/** `archiving`: being put away; `archived`: put away, its clones off the disk; `reviving`: being brought back. */
export type ArchiveState = 'archiving' | 'archived' | 'reviving';

interface Row {
  id: string;
  name: string;
  kind?: string | null;
  group_name?: string | null;
  path: string;
  default_profile: string | null;
  delegation: string | null;
  created_at: number;
  archive_state?: string | null;
  archive_at?: number | null;
}

/** A group from a request: a short label, or null (also for an empty one) to ungroup; undefined when the request does not say. */
export function parseGroup(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string' || v.trim().length > 60)
    throw new BadRequestException(
      '"group" is a label of at most 60 characters, or null',
    );
  return v.trim() || null;
}

/** Validates a delegation value from a request, or throws. */
export function parseDelegation(v: unknown): Delegation {
  if (v === 'free' || v === 'on-request') return v;
  throw new BadRequestException('"delegation" must be "free" or "on-request"');
}

const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * A project is a named set of repositories on this machine. The first repo
 * is the primary: the default cwd for agents and the default home for
 * feature files.
 */
@Injectable()
export class ProjectsService implements OnModuleInit {
  private readonly logger = new Logger(ProjectsService.name);
  constructor(
    private readonly dbs: DbService,
    @Inject(MANAGER_CONFIG) private readonly config: ManagerConfig,
  ) {}

  private get db() {
    return this.dbs.db;
  }

  /** Every project's workspace file is brought up to date at start: projects from before the file existed get one. */
  onModuleInit(): void {
    // A stream that was on its way when the manager stopped is where it
    // set out from: nothing is removed before it is `archived`, and a
    // revival that did not finish is asked for again (the clones that
    // were made are kept).
    this.db
      .prepare(
        "UPDATE projects SET archive_state = NULL, archive_at = NULL WHERE archive_state = 'archiving'",
      )
      .run();
    this.db
      .prepare(
        "UPDATE projects SET archive_state = 'archived' WHERE archive_state = 'reviving'",
      )
      .run();
    for (const p of this.list()) this.keepWorkspace(p);
  }

  /** Marks a stream as put away, on its way, or (null) simply there. */
  setArchive(id: string, state: ArchiveState | null): Project {
    const current = this.get(id);
    this.db
      .prepare(
        'UPDATE projects SET archive_state = ?, archive_at = ? WHERE id = ?',
      )
      .run(
        state,
        state === null
          ? null
          : state === 'reviving' && current.archive
            ? current.archive.at // away since it was put away, not since it began to come back
            : Date.now(),
        id,
      );
    return this.get(id);
  }

  /** Why nothing can be started or said in the project just now: it is a stream put away, or on its way there or back. Null when it is simply there. */
  away(id: string): string | null {
    const row = this.db
      .prepare('SELECT name, archive_state FROM projects WHERE id = ?')
      .get(id) as { name: string; archive_state: string | null } | undefined;
    if (!row?.archive_state) return null;
    return row.archive_state === 'archived'
      ? `the stream "${row.name}" is put away; bring it back first (\`am stream revive ${row.name}\`)`
      : row.archive_state === 'archiving'
        ? `the stream "${row.name}" is being put away`
        : `the stream "${row.name}" is being brought back; its clones are being made`;
  }

  /** Best effort: a directory the manager cannot write to, or a file it cannot parse, is logged, not an error. */
  private keepWorkspace(p: Project): void {
    try {
      const r = writeWorkspace(
        p.name,
        p.kind === 'stream' ? [{ name: '', path: p.path }] : p.repos, // a stream's one folder is its home
        this.config.workspacesDir,
      );
      if (r.result === 'unparseable')
        this.logger.warn(
          `${r.file} is not JSON; left alone (its folders may be stale)`,
        );
      else if (r.result === 'written')
        this.logger.log(`wrote ${r.file} for ${p.name}`);
    } catch (err) {
      this.logger.warn(
        `could not write the workspace file for ${p.name}: ${(err as Error).message}`,
      );
    }
  }

  list(): Project[] {
    return (
      this.db.prepare('SELECT * FROM projects ORDER BY name').all() as Row[]
    ).map((r) => this.toProject(r));
  }

  get(id: string): Project {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(id) as Row | undefined;
    if (!row) throw new NotFoundException(`no project ${id}`);
    return this.toProject(row);
  }

  private toProject(r: Row): Project {
    if (r.kind === 'stream') return this.toStream(r);
    const repos =
      (this.db
        .prepare(
          'SELECT name, path FROM project_repos WHERE project_id = ? ORDER BY position',
        )
        .all(r.id) as Repo[]) ?? [];
    return {
      id: r.id,
      name: r.name,
      kind: 'project',
      group: r.group_name ?? null,
      path: repos[0]?.path ?? r.path,
      repos,
      defaultProfile: r.default_profile,
      delegation: r.delegation === 'on-request' ? 'on-request' : 'free',
      createdAt: r.created_at,
      workspace: workspacePath(
        r.name,
        repos.length ? repos : [{ name: '', path: r.path }],
        this.config.workspacesDir,
      ),
      archive: null,
    };
  }

  /** A stream: its row holds the home, and the disk says what it has cloned. */
  private toStream(r: Row): Project {
    return {
      id: r.id,
      name: r.name,
      kind: 'stream',
      group: r.group_name ?? null,
      path: r.path,
      repos: [
        {
          name: FOLDER_LINK,
          path: streamFolder(this.config.storeDir, r.name),
          folder: true,
        },
        ...clonesIn(r.path).filter((c) => c.name !== FOLDER_LINK),
      ],
      defaultProfile: r.default_profile,
      delegation: r.delegation === 'on-request' ? 'on-request' : 'free',
      createdAt: r.created_at,
      // one folder, the home: the stream's own folder and its clones are both beneath it
      workspace: workspacePath(
        r.name,
        [{ name: '', path: r.path }],
        this.config.workspacesDir,
      ),
      archive:
        r.archive_state === 'archiving' ||
        r.archive_state === 'archived' ||
        r.archive_state === 'reviving'
          ? { state: r.archive_state, at: r.archive_at ?? r.created_at }
          : null,
    };
  }

  /**
   * Records a stream whose folder and home `StreamsService` has made.
   * The name is the stream's for good: its folder, its home and its
   * branches are called by it.
   */
  createStream(input: {
    name: string;
    home: string;
    defaultProfile: string | null;
    delegation: Delegation;
    group: string | null;
  }): Project {
    if (!STREAM_NAME_RE.test(input.name))
      throw new BadRequestException(
        "a stream's name is lower-case letters, digits and hyphens, at most 63, starting with a letter or digit",
      );
    if (
      this.db.prepare('SELECT 1 FROM projects WHERE name = ?').get(input.name)
    )
      throw new BadRequestException(
        `there is already a project or stream called "${input.name}"`,
      );
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO projects (id, name, path, default_profile, delegation, created_at, kind, group_name) VALUES (?, ?, ?, ?, ?, ?, 'stream', ?)",
      )
      .run(
        id,
        input.name,
        input.home,
        input.defaultProfile,
        input.delegation,
        Date.now(),
        input.group,
      );
    const project = this.get(id);
    this.keepWorkspace(project);
    return project;
  }

  /** Validates a repo list from a request (`repos`, or a single `path` for the one-repo case). */
  private parseRepos(input: { path?: unknown; repos?: unknown }): Repo[] {
    let raw: unknown[];
    if (Array.isArray(input.repos)) raw = input.repos;
    else if (typeof input.path === 'string') raw = [{ path: input.path }];
    else
      throw new BadRequestException(
        '"repos" (a list of { name?, path }) or "path" is required',
      );
    if (raw.length === 0)
      throw new BadRequestException('a project needs at least one repository');
    const repos: Repo[] = [];
    for (const r of raw) {
      const p = typeof r === 'string' ? r : (r as { path?: unknown })?.path;
      const n =
        typeof r === 'string' ? undefined : (r as { name?: unknown })?.name;
      if (typeof p !== 'string' || !path.isAbsolute(p))
        throw new BadRequestException(
          'each repo "path" must be an absolute path',
        );
      const resolved = path.resolve(p);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory())
        throw new BadRequestException(`not a directory: ${resolved}`);
      const name =
        n === undefined || n === null || n === '' ? path.basename(resolved) : n;
      if (typeof name !== 'string' || !REPO_NAME_RE.test(name))
        throw new BadRequestException(`invalid repo name: ${String(name)}`);
      if (repos.some((x) => x.name === name))
        throw new BadRequestException(`duplicate repo name: ${name}`);
      if (repos.some((x) => x.path === resolved))
        throw new BadRequestException(`duplicate repo path: ${resolved}`);
      repos.push({ name, path: resolved });
    }
    return repos;
  }

  create(input: {
    name?: unknown;
    path?: unknown;
    repos?: unknown;
    defaultProfile?: unknown;
    delegation?: unknown;
    group?: unknown;
  }): Project {
    if (typeof input.name !== 'string' || input.name.trim() === '')
      throw new BadRequestException('"name" is required');
    if (
      input.defaultProfile !== undefined &&
      input.defaultProfile !== null &&
      typeof input.defaultProfile !== 'string'
    ) {
      throw new BadRequestException('"defaultProfile" must be a string');
    }
    const delegation =
      input.delegation === undefined
        ? 'free'
        : parseDelegation(input.delegation);
    const repos = this.parseRepos(input);
    const id = randomUUID();
    const createdAt = Date.now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO projects (id, name, path, default_profile, delegation, created_at, group_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          id,
          (input.name as string).trim(),
          repos[0].path,
          (input.defaultProfile as string | null) ?? null,
          delegation,
          createdAt,
          parseGroup(input.group) ?? null,
        );
      this.saveRepos(id, repos);
    });
    tx();
    const project = this.get(id);
    this.keepWorkspace(project);
    return project;
  }

  update(
    id: string,
    input: {
      name?: unknown;
      defaultProfile?: unknown;
      repos?: unknown;
      path?: unknown;
      delegation?: unknown;
      group?: unknown;
    },
  ): Project {
    const current = this.get(id);
    // The group is the one thing both kinds set the same way.
    const group = parseGroup(input.group);
    if (group !== undefined)
      this.db
        .prepare('UPDATE projects SET group_name = ? WHERE id = ?')
        .run(group, id);
    if (current.kind === 'stream') return this.updateStream(current, input);
    const name = input.name === undefined ? current.name : input.name;
    const defaultProfile =
      input.defaultProfile === undefined
        ? current.defaultProfile
        : input.defaultProfile;
    if (typeof name !== 'string' || name.trim() === '')
      throw new BadRequestException('"name" must be a non-empty string');
    if (defaultProfile !== null && typeof defaultProfile !== 'string')
      throw new BadRequestException(
        '"defaultProfile" must be a string or null',
      );
    const delegation =
      input.delegation === undefined
        ? current.delegation
        : parseDelegation(input.delegation);
    const repos =
      input.repos !== undefined || input.path !== undefined
        ? this.parseRepos(input)
        : current.repos;
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          'UPDATE projects SET name = ?, default_profile = ?, delegation = ?, path = ? WHERE id = ?',
        )
        .run(name.trim(), defaultProfile, delegation, repos[0].path, id);
      if (repos !== current.repos) this.saveRepos(id, repos);
    });
    tx();
    const project = this.get(id);
    this.keepWorkspace(project);
    return project;
  }

  /** A stream's settings: its default profile and its delegation rule. Its name and what it has cloned are not settings. */
  private updateStream(
    current: Project,
    input: {
      name?: unknown;
      defaultProfile?: unknown;
      repos?: unknown;
      path?: unknown;
      delegation?: unknown;
    },
  ): Project {
    if (input.name !== undefined && input.name !== current.name)
      throw new BadRequestException(
        'a stream keeps its name: its folder, its home and its branches are called by it',
      );
    if (input.repos !== undefined || input.path !== undefined)
      throw new BadRequestException(
        'a stream has no list of repositories to set: it clones what it works on into its home (`am use <repository>`)',
      );
    const defaultProfile =
      input.defaultProfile === undefined
        ? current.defaultProfile
        : input.defaultProfile;
    if (defaultProfile !== null && typeof defaultProfile !== 'string')
      throw new BadRequestException(
        '"defaultProfile" must be a string or null',
      );
    const delegation =
      input.delegation === undefined
        ? current.delegation
        : parseDelegation(input.delegation);
    this.db
      .prepare(
        'UPDATE projects SET default_profile = ?, delegation = ? WHERE id = ?',
      )
      .run(defaultProfile, delegation, current.id);
    return this.get(current.id);
  }

  private saveRepos(id: string, repos: Repo[]): void {
    this.db.prepare('DELETE FROM project_repos WHERE project_id = ?').run(id);
    const insert = this.db.prepare(
      'INSERT INTO project_repos (project_id, name, path, position) VALUES (?, ?, ?, ?)',
    );
    repos.forEach((r, i) => insert.run(id, r.name, r.path, i));
  }

  remove(id: string): void {
    this.get(id);
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  /** Resolves a repo by name or absolute path within a project. */
  repoOf(project: Project, ref: string): Repo | undefined {
    return project.repos.find(
      (r) => r.name === ref || r.path === path.resolve(ref),
    );
  }
}
