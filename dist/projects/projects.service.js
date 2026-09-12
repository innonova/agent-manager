var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { BadRequestException, Injectable, NotFoundException, } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DbService } from '../db/db.service.js';
const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
let ProjectsService = class ProjectsService {
    dbs;
    constructor(dbs) {
        this.dbs = dbs;
    }
    get db() {
        return this.dbs.db;
    }
    list() {
        return this.db.prepare('SELECT * FROM projects ORDER BY name').all().map((r) => this.toProject(r));
    }
    get(id) {
        const row = this.db
            .prepare('SELECT * FROM projects WHERE id = ?')
            .get(id);
        if (!row)
            throw new NotFoundException(`no project ${id}`);
        return this.toProject(row);
    }
    toProject(r) {
        const repos = this.db
            .prepare('SELECT name, path FROM project_repos WHERE project_id = ? ORDER BY position')
            .all(r.id) ?? [];
        return {
            id: r.id,
            name: r.name,
            path: repos[0]?.path ?? r.path,
            repos,
            defaultProfile: r.default_profile,
            createdAt: r.created_at,
        };
    }
    parseRepos(input) {
        let raw;
        if (Array.isArray(input.repos))
            raw = input.repos;
        else if (typeof input.path === 'string')
            raw = [{ path: input.path }];
        else
            throw new BadRequestException('"repos" (a list of { name?, path }) or "path" is required');
        if (raw.length === 0)
            throw new BadRequestException('a project needs at least one repository');
        const repos = [];
        for (const r of raw) {
            const p = typeof r === 'string' ? r : r?.path;
            const n = typeof r === 'string' ? undefined : r?.name;
            if (typeof p !== 'string' || !path.isAbsolute(p))
                throw new BadRequestException('each repo "path" must be an absolute path');
            const resolved = path.resolve(p);
            if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory())
                throw new BadRequestException(`not a directory: ${resolved}`);
            const name = n === undefined || n === null || n === '' ? path.basename(resolved) : n;
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
    create(input) {
        if (typeof input.name !== 'string' || input.name.trim() === '')
            throw new BadRequestException('"name" is required');
        if (input.defaultProfile !== undefined &&
            input.defaultProfile !== null &&
            typeof input.defaultProfile !== 'string') {
            throw new BadRequestException('"defaultProfile" must be a string');
        }
        const repos = this.parseRepos(input);
        const id = randomUUID();
        const createdAt = Date.now();
        const tx = this.db.transaction(() => {
            this.db
                .prepare('INSERT INTO projects (id, name, path, default_profile, created_at) VALUES (?, ?, ?, ?, ?)')
                .run(id, input.name.trim(), repos[0].path, input.defaultProfile ?? null, createdAt);
            this.saveRepos(id, repos);
        });
        tx();
        return this.get(id);
    }
    update(id, input) {
        const current = this.get(id);
        const name = input.name === undefined ? current.name : input.name;
        const defaultProfile = input.defaultProfile === undefined
            ? current.defaultProfile
            : input.defaultProfile;
        if (typeof name !== 'string' || name.trim() === '')
            throw new BadRequestException('"name" must be a non-empty string');
        if (defaultProfile !== null && typeof defaultProfile !== 'string')
            throw new BadRequestException('"defaultProfile" must be a string or null');
        const repos = input.repos !== undefined || input.path !== undefined
            ? this.parseRepos(input)
            : current.repos;
        const tx = this.db.transaction(() => {
            this.db
                .prepare('UPDATE projects SET name = ?, default_profile = ?, path = ? WHERE id = ?')
                .run(name.trim(), defaultProfile, repos[0].path, id);
            if (repos !== current.repos)
                this.saveRepos(id, repos);
        });
        tx();
        return this.get(id);
    }
    saveRepos(id, repos) {
        this.db.prepare('DELETE FROM project_repos WHERE project_id = ?').run(id);
        const insert = this.db.prepare('INSERT INTO project_repos (project_id, name, path, position) VALUES (?, ?, ?, ?)');
        repos.forEach((r, i) => insert.run(id, r.name, r.path, i));
    }
    remove(id) {
        this.get(id);
        this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    }
    repoOf(project, ref) {
        return project.repos.find((r) => r.name === ref || r.path === path.resolve(ref));
    }
};
ProjectsService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [DbService])
], ProjectsService);
export { ProjectsService };
//# sourceMappingURL=projects.service.js.map