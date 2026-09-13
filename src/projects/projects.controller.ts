import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Inject,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { AgentsService, AgentCounts } from '../agents/agents.service.js';
import type { User } from '../auth/auth.service.js';
import { MANAGER_CONFIG } from '../config/config.js';
import type { ManagerConfig } from '../config/config.js';
import { HubService } from '../hub/hub.service.js';
import { Project, ProjectsService } from './projects.service.js';

@Controller('api/projects')
export class ProjectsController {
  constructor(
    @Inject(MANAGER_CONFIG) private readonly config: ManagerConfig,
    private readonly projects: ProjectsService,
    private readonly agents: AgentsService,
    private readonly hub: HubService,
  ) {}

  /** This machine's projects, each with `host`, and (as a hub) the spokes' projects with prefixed ids. */
  @Get()
  async list(
    @Req() req: Request & { user?: User },
  ): Promise<
    { project: Project & { host: string }; agentCounts: AgentCounts }[]
  > {
    const local = this.projects.list().map((project) => ({
      project: { ...project, host: this.config.hostName },
      agentCounts: this.agents.counts(project.id),
    }));
    if (!this.hub.enabled) return local;
    const remote = (await this.hub.listRemoteProjects(
      req.user?.name ?? 'hub',
    )) as {
      project: Project & { host: string };
      agentCounts: AgentCounts;
    }[];
    return [...local, ...remote];
  }

  /** `host` names the machine the project is on; absent or this machine's name creates it here. */
  @Post()
  async create(
    @Req() req: Request & { user?: User },
    @Body() body: Record<string, unknown>,
  ): Promise<{
    project: Project & { host: string };
    agentCounts: AgentCounts;
  }> {
    const { host, ...rest } = body;
    if (typeof host === 'string' && host !== this.config.hostName) {
      const spoke = this.hub.spokes.get(host);
      if (!spoke)
        throw new HttpException(
          { statusCode: 404, message: `no host ${host}` },
          404,
        );
      let r: {
        status: number;
        body: { project: Project & { host: string }; agentCounts: AgentCounts };
      };
      try {
        r = await this.hub.call(
          spoke,
          'POST',
          '/api/projects',
          req.user?.name ?? 'hub',
          rest,
        );
      } catch (err) {
        throw new HttpException(
          {
            statusCode: 502,
            code: 'spoke-unreachable',
            message: `${host} is not reachable: ${(err as Error).message}`,
          },
          502,
        );
      }
      if (r.status >= 400)
        throw new HttpException(r.body as Record<string, unknown>, r.status);
      return r.body;
    }
    const project = this.projects.create(rest);
    return {
      project: { ...project, host: this.config.hostName },
      agentCounts: this.agents.counts(project.id),
    };
  }

  @Get(':id')
  get(@Param('id') id: string): { project: Project; agentCounts: AgentCounts } {
    return {
      project: this.projects.get(id),
      agentCounts: this.agents.counts(id),
    };
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ): { project: Project; agentCounts: AgentCounts } {
    return {
      project: this.projects.update(id, body),
      agentCounts: this.agents.counts(id),
    };
  }

  /** Stops the project's agents, forgets them, then deletes the project. The repository is untouched. */
  @Delete(':id')
  async remove(@Param('id') id: string): Promise<{ ok: true }> {
    this.projects.get(id);
    await this.agents.removeProject(id);
    try {
      this.projects.remove(id);
    } finally {
      this.agents.releaseProject(id);
    }
    return { ok: true };
  }
}
