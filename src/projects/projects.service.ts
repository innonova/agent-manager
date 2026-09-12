import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DbService } from '../db/db.service.js';

export interface Repo {
  name: string;
  path: string;
}

export interface Project {
  id: string;
  name: string;
  /** The primary repo's path; kept for clients that think in one path. */
  path: string;
  repos: Repo[];
  defaultProfile: string | null;
  createdAt: number;
}

interface Row {
  id: string;
  name: string;
  path: string;
  default_profile: string | null;
  created_at: number;
}

const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * A project is a named set of repositories on this machine. The first repo
 * is the primary: the default cwd for agents and the default home for
 * feature files.
 */
@Injectable()
export class ProjectsService {
  constructor(private readonly dbs: DbService) {}

  private get db() {
    return this.dbs.db;
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
    const repos =
      (this.db
        .prepare(
          'SELECT name, path FROM project_repos WHERE project_id = ? ORDER BY position',
        )
        .all(r.id) as Repo[]) ?? [];
    return {
      id: r.id,
      name: r.name,
      path: repos[0]?.path ?? r.path,
      repos,
      defaultProfile: r.default_profile,
      createdAt: r.created_at,
    };
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
    const repos = this.parseRepos(input);
    const id = randomUUID();
    const createdAt = Date.now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO projects (id, name, path, default_profile, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(
          id,
          (input.name as string).trim(),
          repos[0].path,
          (input.defaultProfile as string | null) ?? null,
          createdAt,
        );
      this.saveRepos(id, repos);
    });
    tx();
    return this.get(id);
  }

  update(
    id: string,
    input: {
      name?: unknown;
      defaultProfile?: unknown;
      repos?: unknown;
      path?: unknown;
    },
  ): Project {
    const current = this.get(id);
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
    const repos =
      input.repos !== undefined || input.path !== undefined
        ? this.parseRepos(input)
        : current.repos;
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          'UPDATE projects SET name = ?, default_profile = ?, path = ? WHERE id = ?',
        )
        .run(name.trim(), defaultProfile, repos[0].path, id);
      if (repos !== current.repos) this.saveRepos(id, repos);
    });
    tx();
    return this.get(id);
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
