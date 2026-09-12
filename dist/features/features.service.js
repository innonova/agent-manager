var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var FeaturesService_1;
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { AgentsService } from '../agents/agents.service.js';
import { DbService } from '../db/db.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { FEATURE_STATUSES, isSlug, readFeature, readFeatures, writeFeature, } from './feature-file.js';
let FeaturesService = FeaturesService_1 = class FeaturesService extends EventEmitter {
    dbs;
    projects;
    agents;
    logger = new Logger(FeaturesService_1.name);
    constructor(dbs, projects, agents) {
        super();
        this.dbs = dbs;
        this.projects = projects;
        this.agents = agents;
    }
    get db() {
        return this.dbs.db;
    }
    onModuleInit() {
        this.agents.on('state', (agentId, projectId, status) => void this.onAgentState(agentId, projectId, status).catch((err) => this.logger.error(`feature update failed: ${err.message}`)));
    }
    async list(projectId) {
        const project = this.projects.get(projectId);
        const files = await readFeatures(project.path);
        const features = files.map((f) => this.decorate(projectId, f));
        const order = {
            'in-progress': 0,
            queued: 1,
            review: 2,
            blocked: 3,
            planned: 4,
            done: 5,
        };
        return features.sort((a, b) => order[a.status] - order[b.status] ||
            a.priority - b.priority ||
            a.slug.localeCompare(b.slug));
    }
    async get(projectId, slug) {
        const project = this.projects.get(projectId);
        const f = isSlug(slug) ? await readFeature(project.path, slug) : null;
        if (!f)
            throw new NotFoundException(`no feature ${slug}`);
        return this.decorate(projectId, f);
    }
    decorate(projectId, f) {
        const q = this.db
            .prepare('SELECT * FROM feature_queue WHERE project_id = ? AND slug = ?')
            .get(projectId, f.slug);
        const run = this.db
            .prepare('SELECT * FROM feature_runs WHERE project_id = ? AND slug = ? ORDER BY started_at DESC LIMIT 1')
            .get(projectId, f.slug);
        const { extra: _extra, ...rest } = f;
        return {
            ...rest,
            agentId: q?.agent_id ?? (run && run.ended_at === null ? run.agent_id : null),
            queuedAt: q?.queued_at ?? null,
            lastRun: run
                ? {
                    id: run.id,
                    agentId: run.agent_id,
                    startedAt: run.started_at,
                    endedAt: run.ended_at,
                    outcome: run.outcome,
                }
                : null,
        };
    }
    async create(projectId, input) {
        const project = this.projects.get(projectId);
        if (!isSlug(input.slug))
            throw new BadRequestException('"slug" must be lowercase letters, digits, dot, dash or underscore');
        if (typeof input.title !== 'string' || !input.title.trim())
            throw new BadRequestException('"title" is required');
        if (input.body !== undefined && typeof input.body !== 'string')
            throw new BadRequestException('"body" must be a string');
        const priority = input.priority === undefined ? 100 : Number(input.priority);
        if (!Number.isFinite(priority))
            throw new BadRequestException('"priority" must be a number');
        const dependsOn = input.dependsOn === undefined
            ? []
            : Array.isArray(input.dependsOn) && input.dependsOn.every(isSlug)
                ? input.dependsOn
                : null;
        if (!dependsOn)
            throw new BadRequestException('"dependsOn" must be a list of slugs');
        if (await readFeature(project.path, input.slug))
            throw new ConflictException(`feature ${input.slug} already exists`);
        const f = {
            slug: input.slug,
            path: `features/${input.slug}.md`,
            title: input.title.trim(),
            status: 'planned',
            priority,
            profile: null,
            dependsOn,
            body: input.body ?? '',
            extra: {},
            mtime: Date.now(),
        };
        await writeFeature(project.path, f);
        const feature = await this.get(projectId, f.slug);
        this.emit('changed', projectId, feature);
        return feature;
    }
    async setStatus(projectId, slug, status) {
        const project = this.projects.get(projectId);
        if (!FEATURE_STATUSES.includes(status) ||
            status === 'queued' ||
            status === 'in-progress') {
            throw new BadRequestException('"status" must be one of planned, review, blocked, done');
        }
        const f = isSlug(slug) ? await readFeature(project.path, slug) : null;
        if (!f)
            throw new NotFoundException(`no feature ${slug}`);
        if (f.status === 'in-progress')
            throw new ConflictException('feature is being worked on; stop or wait first');
        this.db
            .prepare('DELETE FROM feature_queue WHERE project_id = ? AND slug = ?')
            .run(projectId, slug);
        f.status = status;
        await writeFeature(project.path, f);
        const feature = await this.get(projectId, slug);
        this.emit('changed', projectId, feature);
        return feature;
    }
    async queue(projectId, slug, input) {
        const project = this.projects.get(projectId);
        if (typeof input.agentId !== 'string')
            throw new BadRequestException('"agentId" is required');
        const agent = this.agents.get(input.agentId);
        if (agent.projectId !== projectId || agent.archivedAt)
            throw new BadRequestException('agent does not belong to this project');
        const f = isSlug(slug) ? await readFeature(project.path, slug) : null;
        if (!f)
            throw new NotFoundException(`no feature ${slug}`);
        if (f.status === 'in-progress' || f.status === 'queued')
            throw new ConflictException(`feature is already ${f.status}`);
        if (f.status === 'done')
            throw new ConflictException('feature is done; reopen it first');
        const all = await readFeatures(project.path);
        const unmet = f.dependsOn.filter((d) => all.find((x) => x.slug === d)?.status !== 'done');
        if (unmet.length)
            throw new ConflictException(`depends on unfinished feature(s): ${unmet.join(', ')}`);
        this.db
            .prepare('INSERT INTO feature_queue (project_id, slug, agent_id, queued_at) VALUES (?, ?, ?, ?)')
            .run(projectId, slug, agent.id, Date.now());
        f.status = 'queued';
        await writeFeature(project.path, f);
        this.emit('changed', projectId, await this.get(projectId, slug));
        await this.startNext(agent.id);
        return this.get(projectId, slug);
    }
    async dequeue(projectId, slug) {
        const project = this.projects.get(projectId);
        const f = isSlug(slug) ? await readFeature(project.path, slug) : null;
        if (!f)
            throw new NotFoundException(`no feature ${slug}`);
        if (f.status !== 'queued')
            throw new ConflictException('feature is not queued');
        this.db
            .prepare('DELETE FROM feature_queue WHERE project_id = ? AND slug = ?')
            .run(projectId, slug);
        f.status = 'planned';
        await writeFeature(project.path, f);
        const feature = await this.get(projectId, slug);
        this.emit('changed', projectId, feature);
        return feature;
    }
    async startNext(agentId) {
        const status = this.agents.status(agentId);
        if (status.state !== 'idle' &&
            status.state !== 'exited' &&
            status.state !== 'error')
            return;
        const open = this.db
            .prepare('SELECT * FROM feature_runs WHERE agent_id = ? AND ended_at IS NULL')
            .get(agentId);
        if (open)
            return;
        const next = this.db
            .prepare('SELECT * FROM feature_queue WHERE agent_id = ? ORDER BY queued_at LIMIT 1')
            .get(agentId);
        if (!next)
            return;
        const project = this.projects.get(next.project_id);
        const f = await readFeature(project.path, next.slug);
        this.db
            .prepare('DELETE FROM feature_queue WHERE project_id = ? AND slug = ?')
            .run(next.project_id, next.slug);
        if (!f)
            return this.startNext(agentId);
        const run = {
            id: randomUUID(),
            project_id: next.project_id,
            slug: next.slug,
            agent_id: agentId,
            started_at: Date.now(),
            ended_at: null,
            outcome: null,
        };
        this.db
            .prepare('INSERT INTO feature_runs (id, project_id, slug, agent_id, started_at) VALUES (?, ?, ?, ?, ?)')
            .run(run.id, run.project_id, run.slug, run.agent_id, run.started_at);
        f.status = 'in-progress';
        await writeFeature(project.path, f);
        this.emit('changed', next.project_id, await this.get(next.project_id, next.slug));
        try {
            await this.agents.turn(agentId, prompt(f));
        }
        catch (err) {
            this.logger.warn(`could not start feature ${next.slug} on agent ${agentId}: ${err.message}`);
            await this.finishRun(run, 'blocked', `could not send the turn: ${err.message}`);
        }
    }
    async onAgentState(agentId, projectId, status) {
        const open = this.db
            .prepare('SELECT * FROM feature_runs WHERE agent_id = ? AND ended_at IS NULL')
            .get(agentId);
        if (open) {
            if (status.state === 'idle')
                await this.finishRun(open, 'review', null);
            else if (status.state === 'error')
                await this.finishRun(open, 'blocked', status.error);
            else if (status.state === 'exited')
                await this.finishRun(open, 'blocked', 'the agent session ended');
            else
                return;
        }
        if (status.state === 'idle' ||
            status.state === 'error' ||
            status.state === 'exited')
            await this.startNext(agentId);
        void projectId;
    }
    async finishRun(run, status, note) {
        this.db
            .prepare('UPDATE feature_runs SET ended_at = ?, outcome = ? WHERE id = ? AND ended_at IS NULL')
            .run(Date.now(), note ? `${status}: ${note}` : status, run.id);
        const project = this.projects.get(run.project_id);
        const f = await readFeature(project.path, run.slug);
        if (f && f.status === 'in-progress') {
            f.status = status;
            await writeFeature(project.path, f);
        }
        this.emit('changed', run.project_id, await this.get(run.project_id, run.slug));
    }
};
FeaturesService = FeaturesService_1 = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [DbService,
        ProjectsService,
        AgentsService])
], FeaturesService);
export { FeaturesService };
export function prompt(f) {
    return [
        `Implement the feature "${f.title}", described in ${f.path} of this repository.`,
        '',
        f.body.trim() || '(The feature file has no description beyond its title.)',
        '',
        'Work directly in this repository. When you are done, reply with a short summary of what you changed and anything you left open.',
        `Do not change the status field in ${f.path}; the manager maintains it.`,
    ].join('\n');
}
//# sourceMappingURL=features.service.js.map