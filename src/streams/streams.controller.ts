import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
import {
  ArchivePlan,
  ArchiveProgress,
  ArchiveRecord,
  ArchiveService,
} from './archive.service.js';

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
    private readonly archive: ArchiveService,
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

  /** Starts a clone and answers at once; `GET …/clones` says how far it is. With `again`, runs the setup of a clone that is there once more. */
  @Post('projects/:id/clones')
  @HttpCode(202)
  use(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ): { clone: Clone } {
    return {
      clone: this.streams.use(id, body?.repository, body?.again === true),
    };
  }

  /** Where a stream is (put away, on its way, or simply there) and how the last attempt to move it went. */
  @Get('projects/:id/archive')
  archiveStatus(@Param('id') id: string): {
    archive: Project['archive'];
    progress: ArchiveProgress;
    record: ArchiveRecord | null;
  } {
    return this.archive.status(id);
  }

  /** What putting the stream away would do and what stands in its way. Asks the clones' remotes: seconds. */
  @Get('projects/:id/archive/plan')
  async archivePlan(@Param('id') id: string): Promise<{ plan: ArchivePlan }> {
    return { plan: await this.archive.plan(id) };
  }

  /**
   * Puts a stream away: a person's to do. `discard: true` lets files
   * that are not committed go with the clones; `compact: false` leaves
   * the agents' contexts as they are. Refused (409, with the plan) when
   * something stands in the way; otherwise answers at once and goes on
   * in the background.
   */
  @Post('projects/:id/archive')
  @HttpCode(202)
  async putAway(
    @Req() req: Request & { user?: User; agentScope?: unknown },
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ): Promise<{ project: Project }> {
    this.personOnly(req);
    return {
      project: await this.archive.archive(
        id,
        body ?? {},
        req.user?.name ?? 'someone',
        req.user?.id,
      ),
    };
  }

  /** Brings a stream back: its clones made again, its agents told what landed meanwhile. Answers at once. */
  @Post('projects/:id/revive')
  @HttpCode(202)
  revive(
    @Req() req: Request & { user?: User; agentScope?: unknown },
    @Param('id') id: string,
  ): { project: Project } {
    this.personOnly(req);
    return { project: this.archive.revive(id, req.user?.name ?? 'someone') };
  }

  /** Said here as well as in what an agent's token is allowed: a rule about losing work does not rest on how an address is spelled. */
  private personOnly(req: { agentScope?: unknown }): void {
    if (req.agentScope)
      throw new ForbiddenException(
        "putting a stream away and bringing it back are a person's to do",
      );
  }
}
