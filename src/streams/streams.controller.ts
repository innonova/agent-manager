import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { AgentsService, AgentCounts } from '../agents/agents.service.js';
import type { User } from '../auth/auth.service.js';
import { MANAGER_CONFIG } from '../config/config.js';
import type { ManagerConfig } from '../config/config.js';
import type { Project } from '../projects/projects.service.js';
import { Clone, Repository, StreamsService } from './streams.service.js';

/**
 * Streams (`docs/streams.md`). A stream is listed, read, changed and
 * deleted as the project it is recorded as (`/api/projects`); what is
 * a stream's alone is here: starting one, the registry of repositories,
 * and the clones in its home.
 */
@Controller('api')
export class StreamsController {
  constructor(
    @Inject(MANAGER_CONFIG) private readonly config: ManagerConfig,
    private readonly streams: StreamsService,
    private readonly agents: AgentsService,
  ) {}

  @Post('streams')
  async create(
    @Req() req: Request & { user?: User },
    @Body() body: Record<string, unknown>,
  ): Promise<{
    project: Project & { host: string; sshHost: string };
    agentCounts: AgentCounts;
  }> {
    const project = await this.streams.create(
      body ?? {},
      req.user?.name ?? 'someone',
    );
    return {
      project: {
        ...project,
        host: this.config.hostName,
        sshHost: this.config.sshHost,
      },
      agentCounts: this.agents.counts(project.id),
    };
  }

  @Get('repositories')
  repositories(): { repositories: Repository[] } {
    return { repositories: this.streams.repositories() };
  }

  @Put('repositories/:name')
  put(
    @Param('name') name: string,
    @Body() body: Record<string, unknown>,
  ): { repository: Repository } {
    return { repository: this.streams.putRepository(name, body ?? {}) };
  }

  @Put('repositories/:name/seed')
  async seed(
    @Param('name') name: string,
    @Body() body: Record<string, unknown>,
  ): Promise<{ repository: Repository }> {
    return { repository: await this.streams.seed(name, body ?? {}) };
  }

  @Delete('repositories/:name')
  remove(@Param('name') name: string): { ok: true } {
    this.streams.removeRepository(name);
    return { ok: true };
  }

  @Get('projects/:id/clones')
  async clones(@Param('id') id: string): Promise<{ clones: Clone[] }> {
    return { clones: await this.streams.clones(id) };
  }

  /** Starts a clone and answers at once; `GET …/clones` says how far it is. */
  @Post('projects/:id/clones')
  @HttpCode(202)
  use(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ): { clone: Clone } {
    return { clone: this.streams.use(id, body?.repository) };
  }
}
