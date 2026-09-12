import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DbService } from '../db/db.service.js';

export interface Project {
  id: string;
  name: string;
  path: string;
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

const toProject = (r: Row): Project => ({
  id: r.id,
  name: r.name,
  path: r.path,
  defaultProfile: r.default_profile,
  createdAt: r.created_at,
});

@Injectable()
export class ProjectsService {
  constructor(private readonly dbs: DbService) {}

  private get db() {
    return this.dbs.db;
  }

  list(): Project[] {
    return (
      this.db.prepare('SELECT * FROM projects ORDER BY name').all() as Row[]
    ).map(toProject);
  }

  get(id: string): Project {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(id) as Row | undefined;
    if (!row) throw new NotFoundException(`no project ${id}`);
    return toProject(row);
  }

  create(input: {
    name?: unknown;
    path?: unknown;
    defaultProfile?: unknown;
  }): Project {
    if (typeof input.name !== 'string' || input.name.trim() === '')
      throw new BadRequestException('"name" is required');
    if (typeof input.path !== 'string' || !path.isAbsolute(input.path))
      throw new BadRequestException('"path" must be an absolute path');
    if (
      input.defaultProfile !== undefined &&
      input.defaultProfile !== null &&
      typeof input.defaultProfile !== 'string'
    ) {
      throw new BadRequestException('"defaultProfile" must be a string');
    }
    const resolved = path.resolve(input.path);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory())
      throw new BadRequestException(`"path" is not a directory: ${resolved}`);
    const project: Project = {
      id: randomUUID(),
      name: input.name.trim(),
      path: resolved,
      defaultProfile: (input.defaultProfile as string | null) ?? null,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        'INSERT INTO projects (id, name, path, default_profile, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        project.id,
        project.name,
        project.path,
        project.defaultProfile,
        project.createdAt,
      );
    return project;
  }

  update(
    id: string,
    input: { name?: unknown; defaultProfile?: unknown },
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
    this.db
      .prepare('UPDATE projects SET name = ?, default_profile = ? WHERE id = ?')
      .run(name.trim(), defaultProfile, id);
    return this.get(id);
  }

  remove(id: string): void {
    this.get(id);
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }
}
