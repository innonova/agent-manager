import { Agent, AgentSessionRef, AgentStatus, AgentsService, StoredItem } from './agents.service.js';
export declare class AgentsController {
    private readonly agents;
    constructor(agents: AgentsService);
    list(projectId: string): {
        agent: Agent;
        status: AgentStatus;
    }[];
    create(projectId: string, body: Record<string, unknown>): Promise<{
        agent: Agent;
        status: AgentStatus;
    }>;
    get(id: string): {
        agent: Agent;
        status: AgentStatus;
        sessions: AgentSessionRef[];
    };
    items(id: string, from?: string): {
        items: StoredItem[];
    };
    turn(id: string, body: {
        text?: unknown;
    }): Promise<{
        ok: true;
    }>;
    interrupt(id: string): Promise<{
        ok: true;
    }>;
    stop(id: string): Promise<{
        ok: true;
    }>;
    archive(id: string): Promise<{
        ok: true;
    }>;
}
