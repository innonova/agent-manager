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
const toProject = (r) => ({
    id: r.id,
    name: r.name,
    path: r.path,
    defaultProfile: r.default_profile,
    createdAt: r.created_at,
});
let ProjectsService = class ProjectsService {
    dbs;
    constructor(dbs) {
        this.dbs = dbs;
    }
    get db() {
        return this.dbs.db;
    }
    list() {
        return this.db.prepare('SELECT * FROM projects ORDER BY name').all().map(toProject);
    }
    get(id) {
        const row = this.db
            .prepare('SELECT * FROM projects WHERE id = ?')
            .get(id);
        if (!row)
            throw new NotFoundException(`no project ${id}`);
        return toProject(row);
    }
    create(input) {
        if (typeof input.name !== 'string' || input.name.trim() === '')
            throw new BadRequestException('"name" is required');
        if (typeof input.path !== 'string' || !path.isAbsolute(input.path))
            throw new BadRequestException('"path" must be an absolute path');
        if (input.defaultProfile !== undefined &&
            input.defaultProfile !== null &&
            typeof input.defaultProfile !== 'string') {
            throw new BadRequestException('"defaultProfile" must be a string');
        }
        const resolved = path.resolve(input.path);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory())
            throw new BadRequestException(`"path" is not a directory: ${resolved}`);
        const project = {
            id: randomUUID(),
            name: input.name.trim(),
            path: resolved,
            defaultProfile: input.defaultProfile ?? null,
            createdAt: Date.now(),
        };
        this.db
            .prepare('INSERT INTO projects (id, name, path, default_profile, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(project.id, project.name, project.path, project.defaultProfile, project.createdAt);
        return project;
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
        this.db
            .prepare('UPDATE projects SET name = ?, default_profile = ? WHERE id = ?')
            .run(name.trim(), defaultProfile, id);
        return this.get(id);
    }
    remove(id) {
        this.get(id);
        this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    }
};
ProjectsService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [DbService])
], ProjectsService);
export { ProjectsService };
//# sourceMappingURL=projects.service.js.map