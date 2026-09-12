import { OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { AgentsService } from '../agents/agents.service.js';
import { DbService } from '../db/db.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { FeatureFile } from './feature-file.js';
export interface Feature extends Omit<FeatureFile, 'extra'> {
    agentId: string | null;
    queuedAt: number | null;
    lastRun: {
        id: string;
        agentId: string;
        startedAt: number;
        endedAt: number | null;
        outcome: string | null;
    } | null;
}
export declare class FeaturesService extends EventEmitter<{
    changed: [projectId: string, feature: Feature];
}> implements OnModuleInit {
    private readonly dbs;
    private readonly projects;
    private readonly agents;
    private readonly logger;
    constructor(dbs: DbService, projects: ProjectsService, agents: AgentsService);
    private get db();
    onModuleInit(): void;
    list(projectId: string): Promise<Feature[]>;
    get(projectId: string, slug: string): Promise<Feature>;
    private decorate;
    create(projectId: string, input: {
        slug?: unknown;
        title?: unknown;
        body?: unknown;
        priority?: unknown;
        dependsOn?: unknown;
    }): Promise<Feature>;
    setStatus(projectId: string, slug: string, status: unknown): Promise<Feature>;
    queue(projectId: string, slug: string, input: {
        agentId?: unknown;
    }): Promise<Feature>;
    dequeue(projectId: string, slug: string): Promise<Feature>;
    private startNext;
    private onAgentState;
    private finishRun;
}
export declare function prompt(f: FeatureFile): string;
