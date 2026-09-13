import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { User } from '../auth/auth.service.js';
import {
  Agent,
  AgentSessionRef,
  AgentStatus,
  AgentsService,
  StoredItem,
} from './agents.service.js';

@Controller('api')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get('projects/:projectId/agents')
  list(
    @Param('projectId') projectId: string,
  ): { agent: Agent; status: AgentStatus }[] {
    return this.agents.list(projectId);
  }

  @Post('projects/:projectId/agents')
  create(
    @Param('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ): Promise<{ agent: Agent; status: AgentStatus }> {
    return this.agents.create(projectId, body);
  }

  /** Stops and resumes the project's idle agents so they see changed settings; busy ones are skipped and listed. */
  @Post('projects/:projectId/agents/restart')
  restart(
    @Param('projectId') projectId: string,
  ): Promise<{ restarted: string[]; skipped: { id: string; why: string }[] }> {
    return this.agents.restartIdle(projectId);
  }

  @Get('agents/:id')
  get(@Param('id') id: string): {
    agent: Agent;
    status: AgentStatus;
    sessions: AgentSessionRef[];
  } {
    return {
      agent: this.agents.get(id),
      status: this.agents.status(id),
      sessions: this.agents.sessions(id),
    };
  }

  @Get('agents/:id/items')
  items(
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('tail') tail?: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ): Promise<{ items: StoredItem[]; total: number }> {
    const num = (name: string, raw: string | undefined): number | undefined => {
      if (raw === undefined || raw === '') return undefined;
      const n = Number(raw);
      if (!Number.isSafeInteger(n) || n < 0)
        throw new BadRequestException(
          `"${name}" must be a non-negative integer`,
        );
      return n;
    };
    return this.agents.items(id, {
      from: num('from', from),
      tail: num('tail', tail),
      before: num('before', before),
      limit: num('limit', limit),
    });
  }

  @Post('agents/:id/turn')
  @HttpCode(202)
  async turn(
    @Req() req: Request & { user?: User },
    @Param('id') id: string,
    @Body() body: { text?: unknown },
  ): Promise<{ ok: true }> {
    await this.agents.turn(id, body?.text, req.user?.id);
    return { ok: true };
  }

  @Post('agents/:id/permission')
  async permission(
    @Param('id') id: string,
    @Body() body: { requestId?: unknown; option?: unknown },
  ): Promise<{ ok: true }> {
    await this.agents.decide(id, body?.requestId, body?.option);
    return { ok: true };
  }

  @Post('agents/:id/interrupt')
  async interrupt(@Param('id') id: string): Promise<{ ok: true }> {
    await this.agents.interrupt(id);
    return { ok: true };
  }

  @Post('agents/:id/stop')
  async stop(@Param('id') id: string): Promise<{ ok: true }> {
    await this.agents.stop(id);
    return { ok: true };
  }

  @Post('agents/:id/archive')
  async archive(@Param('id') id: string): Promise<{ ok: true }> {
    await this.agents.archive(id);
    return { ok: true };
  }
}
