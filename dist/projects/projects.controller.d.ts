import { AgentsService, AgentCounts } from '../agents/agents.service.js';
import { Project, ProjectsService } from './projects.service.js';
export declare class ProjectsController {
    private readonly projects;
    private readonly agents;
    constructor(projects: ProjectsService, agents: AgentsService);
    list(): {
        project: Project;
        agentCounts: AgentCounts;
    }[];
    create(body: Record<string, unknown>): {
        project: Project;
        agentCounts: AgentCounts;
    };
    get(id: string): {
        project: Project;
        agentCounts: AgentCounts;
    };
    update(id: string, body: Record<string, unknown>): {
        project: Project;
    };
    remove(id: string): {
        ok: true;
    };
}
