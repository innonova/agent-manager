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
import fs from 'node:fs/promises';
import path from 'node:path';
import { ProjectsService } from '../projects/projects.service.js';
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
let FilesService = class FilesService {
    projects;
    constructor(projects) {
        this.projects = projects;
    }
    resolve(projectId, rel) {
        const project = this.projects.get(projectId);
        const raw = rel === undefined || rel === null ? '' : rel;
        if (typeof raw !== 'string')
            throw new BadRequestException('"path" must be a string');
        const normalised = path.posix
            .normalize(raw.replace(/\\/g, '/'))
            .replace(/^\/+/, '')
            .replace(/\/+$/, '');
        if (normalised === '..' ||
            normalised.startsWith('../') ||
            normalised.includes('/../'))
            throw new BadRequestException('"path" may not leave the project');
        const clean = normalised === '.' ? '' : normalised;
        if (clean === '')
            return { root: true };
        const [repoName, ...rest] = clean.split('/');
        const repo = project.repos.find((r) => r.name === repoName);
        if (!repo)
            throw new NotFoundException(`no such repository in this project: ${repoName}`);
        return { abs: path.join(repo.path, ...rest), rel: clean, repo: repo.name };
    }
    async list(projectId, rel) {
        const target = this.resolve(projectId, rel);
        if ('root' in target) {
            const project = this.projects.get(projectId);
            const entries = await Promise.all(project.repos.map(async (r) => {
                const st = await fs.stat(r.path).catch(() => null);
                return {
                    name: r.name,
                    path: r.name,
                    type: 'dir',
                    size: 0,
                    mtime: st?.mtimeMs ?? 0,
                };
            }));
            return { path: '', entries };
        }
        const { abs, rel: clean } = target;
        let names;
        try {
            names = await fs.readdir(abs, { withFileTypes: true });
        }
        catch (err) {
            if (err.code === 'ENOENT')
                throw new NotFoundException(`no such directory: ${clean || '/'}`);
            if (err.code === 'ENOTDIR')
                throw new BadRequestException(`not a directory: ${clean}`);
            throw err;
        }
        const entries = await Promise.all(names.map(async (d) => {
            const p = clean ? `${clean}/${d.name}` : d.name;
            const type = d.isSymbolicLink()
                ? 'symlink'
                : d.isDirectory()
                    ? 'dir'
                    : d.isFile()
                        ? 'file'
                        : 'other';
            let size = 0;
            let mtime = 0;
            try {
                const st = await fs.stat(path.join(abs, d.name));
                size = st.size;
                mtime = st.mtimeMs;
                if (type === 'symlink')
                    return {
                        name: d.name,
                        path: p,
                        type: st.isDirectory() ? 'dir' : 'symlink',
                        size,
                        mtime,
                    };
            }
            catch {
            }
            return { name: d.name, path: p, type, size, mtime };
        }));
        entries.sort((a, b) => (a.type === 'dir') === (b.type === 'dir')
            ? a.name.localeCompare(b.name)
            : a.type === 'dir'
                ? -1
                : 1);
        return { path: clean, entries };
    }
    async read(projectId, rel) {
        const target = this.resolve(projectId, rel);
        if ('root' in target)
            throw new BadRequestException('is a directory: /');
        const { abs, rel: clean } = target;
        let st;
        try {
            st = await fs.stat(abs);
        }
        catch (err) {
            if (err.code === 'ENOENT')
                throw new NotFoundException(`no such file: ${clean}`);
            throw err;
        }
        if (st.isDirectory())
            throw new BadRequestException(`is a directory: ${clean}`);
        const base = { path: clean, size: st.size, mtime: st.mtimeMs };
        if (st.size > MAX_FILE_BYTES)
            return { ...base, content: '', binary: false, truncated: true };
        const buf = await fs.readFile(abs);
        const head = buf.subarray(0, 8192);
        if (head.includes(0))
            return { ...base, content: '', binary: true, truncated: false };
        return {
            ...base,
            content: buf.toString('utf8'),
            binary: false,
            truncated: false,
        };
    }
};
FilesService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [ProjectsService])
], FilesService);
export { FilesService };
//# sourceMappingURL=files.service.js.map