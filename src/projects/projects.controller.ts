import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { AgentsService, AgentCounts } from '../agents/agents.service.js';
import { Project, ProjectsService } from './projects.service.js';

@Controller('api/projects')
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly agents: AgentsService,
  ) {}

  @Get()
  list(): { project: Project; agentCounts: AgentCounts }[] {
    return this.projects.list().map((project) => ({
      project,
      agentCounts: this.agents.counts(project.id),
    }));
  }

  @Post()
  create(@Body() body: Record<string, unknown>): {
    project: Project;
    agentCounts: AgentCounts;
  } {
    const project = this.projects.create(body);
    return { project, agentCounts: this.agents.counts(project.id) };
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
  ): { project: Project } {
    return { project: this.projects.update(id, body) };
  }

  @Delete(':id')
  remove(@Param('id') id: string): { ok: true } {
    this.projects.remove(id);
    return { ok: true };
  }
}
