import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
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
  ): { items: StoredItem[] } {
    const cursor = from === undefined || from === '' ? 0 : Number(from);
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      throw new BadRequestException('"from" must be a non-negative integer');
    return { items: this.agents.items(id, cursor) };
  }

  @Post('agents/:id/turn')
  @HttpCode(202)
  async turn(
    @Param('id') id: string,
    @Body() body: { text?: unknown },
  ): Promise<{ ok: true }> {
    await this.agents.turn(id, body?.text);
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
