import { OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import type { AgentState, Item } from '../adapters/adapter.js';
import { AdaptersService } from '../adapters/adapters.service.js';
import { DaemonClient } from '../daemon/daemon-client.js';
import { DbService } from '../db/db.service.js';
import { ProjectsService } from '../projects/projects.service.js';
export interface Agent {
    id: string;
    projectId: string;
    name: string;
    profile: string;
    cwd: string;
    vendorConversationId: string | null;
    currentSessionId: string | null;
    createdAt: number;
    archivedAt: number | null;
}
export interface AgentSessionRef {
    daemonSessionId: string;
    startedAt: number;
    endedAt: number | null;
}
export interface AgentStatus {
    state: AgentState;
    error: string | null;
    lastActivityAt: number;
}
export interface StoredItem {
    index: number;
    sessionId: string;
    seqFrom: number;
    seqTo: number;
    item: Item;
}
export type AgentCounts = Record<AgentState, number>;
export interface AgentEvents {
    state: [agentId: string, projectId: string, status: AgentStatus];
    item: [agentId: string, item: StoredItem];
    session: [agentId: string, session: AgentSessionRef];
    counts: [projectId: string, counts: AgentCounts];
}
export declare const LABEL_PREFIX = "agent-manager:";
export declare function emptyCounts(): AgentCounts;
export declare class AgentsService extends EventEmitter<AgentEvents> implements OnModuleInit {
    private readonly dbs;
    private readonly daemon;
    private readonly adapters;
    private readonly projects;
    private readonly logger;
    private readonly live;
    private readonly sessionOwner;
    private resyncChain;
    private resyncGeneration;
    constructor(dbs: DbService, daemon: DaemonClient, adapters: AdaptersService, projects: ProjectsService);
    private get db();
    onModuleInit(): void;
    list(projectId: string): {
        agent: Agent;
        status: AgentStatus;
    }[];
    get(id: string): Agent;
    status(id: string): AgentStatus;
    sessions(id: string): AgentSessionRef[];
    items(id: string, from?: number): StoredItem[];
    counts(projectId: string): AgentCounts;
    create(projectId: string, input: {
        name?: unknown;
        profile?: unknown;
        cwd?: unknown;
    }): Promise<{
        agent: Agent;
        status: AgentStatus;
    }>;
    turn(id: string, text: unknown): Promise<void>;
    interrupt(id: string): Promise<void>;
    stop(id: string): Promise<void>;
    archive(id: string): Promise<void>;
    removeProject(projectId: string): Promise<void>;
    private stopLocked;
    private startSession;
    private trackSession;
    private attachSession;
    private reconcileCurrent;
    private onOutput;
    private apply;
    private applyOp;
    private onSessionChanged;
    private applyExit;
    private scheduleResync;
    private resync;
    private adoptSessions;
    private ensureLive;
    private withLock;
    private awaitStarting;
    private appendItem;
    private setState;
}
