import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AgentScope, User } from '../auth/auth.service.js';
import { AgentsService } from '../agents/agents.service.js';
import type { Agent, AgentStatus } from '../agents/agents.service.js';
import type { Exchange } from './dialog.js';
import { DialogService, ExchangeLine } from './dialog.service.js';

type Caller = Request & { user?: User; agentScope?: AgentScope };

/**
 * An agent's dialog with its people: the record that is handed back
 * after a compaction, for the agent to fetch from (`am recall`) and
 * for a person to read what the classifier made of it.
 */
@Controller('api')
export class DialogController {
  constructor(
    private readonly dialog: DialogService,
    private readonly agents: AgentsService,
  ) {}

  /**
   * Compacts the agent's context now: its dialog is weighed first when
   * that is not fresh, then the vendor's compaction is asked for as a
   * turn of the caller's. Answers at once; 409 while the agent is in a
   * turn and for a vendor the manager cannot ask.
   */
  @Post('agents/:id/compact')
  @HttpCode(202)
  compact(@Req() req: Caller, @Param('id') id: string): { ok: true } {
    this.dialog.compact(id, req.user?.id);
    return { ok: true };
  }

  /**
   * Forks an agent: a new one, in the same project or stream or in
   * `projectId`, that begins with this one's whole conversation and
   * its dialog record, and is told that it is a copy. An agent's own
   * token forks within its project only.
   */
  @Post('agents/:id/fork')
  async fork(
    @Req() req: Caller,
    @Param('id') id: string,
    @Body() body?: Record<string, unknown>,
  ): Promise<{ agent: Agent; status: AgentStatus; inherited: number }> {
    if (
      req.agentScope &&
      body?.projectId !== undefined &&
      body.projectId !== null &&
      body.projectId !== req.agentScope.projectId
    )
      throw new ForbiddenException(
        "an agent forks within its own project; into another is a person's to do",
      );
    let inherited = 0;
    const made = await this.agents.fork(
      id,
      body ?? {},
      req.user?.name ?? null, // an agent's token acts as `agent-<name>`
      // the dialog is taken at the same moment as the conversation, before the fork exists for anyone
      async (forkId) => {
        inherited = await this.dialog.inherit(forkId, id);
      },
    );
    return { ...made, inherited };
  }

  /** Every exchange as one line, with its weight once weighed. */
  @Get('agents/:id/dialog')
  list(@Param('id') id: string): Promise<{
    exchanges: ExchangeLine[];
    weighed: { at: number; model: string; upTo: number } | null;
    weighing: { since: number; model: string } | null;
    failed: { at: number; message: string } | null;
    classifier: string | null;
  }> {
    return this.dialog.list(id);
  }

  /** What would be handed back if the agent's context were compacted now: which exchanges whole, which as lines, and the files' texts. Nothing is written or sent. */
  @Get('agents/:id/dialog/handback')
  async preview(@Param('id') id: string): Promise<{
    recent: number[];
    kept: number[];
    indexed: number;
    tokens: number;
    budget: number;
    files: string[];
  }> {
    const { sel, files, budget } = await this.dialog.preview(id);
    return {
      recent: sel.recent.map((e) => e.n),
      kept: sel.kept.map((e) => e.n),
      indexed: sel.indexed.length,
      tokens: sel.tokens,
      budget,
      files,
    };
  }

  /** One exchange, word for word. */
  @Get('agents/:id/dialog/:n')
  async one(
    @Param('id') id: string,
    @Param('n') n: string,
  ): Promise<{ exchange: Exchange }> {
    const num = Number(n);
    if (!Number.isInteger(num) || num < 1)
      throw new BadRequestException('an exchange is named by its number');
    return { exchange: await this.dialog.exchange(id, num) };
  }

  /**
   * Starts a weighing of the dialog, with the configured classifier or
   * `{ model }` in its place (how a model is tried), and answers at
   * once: it takes minutes. `GET .../dialog` says when it is done
   * (`weighing` gone, `weighed` new) or how it failed.
   */
  @Post('agents/:id/dialog/weigh')
  @HttpCode(202)
  weigh(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ): { weighing: { since: number; model: string } } {
    const model = body?.model;
    if (
      model !== undefined &&
      (typeof model !== 'string' || !/^[\w.[\]:-]{1,80}$/.test(model))
    )
      throw new BadRequestException('"model" is a model name');
    return {
      weighing: this.dialog.start(id, { model: model as string | undefined }),
    };
  }

  /**
   * The agent's dialog handed back to it: the hook Claude Code runs
   * after a compaction asks with no body; the agent itself may ask in
   * the middle of a window with `{ on: 'request' }` (`am recall
   * --handback --now`); the hook of a conversation that begins asks with
   * `{ on: 'start' }` and gets text only when it replaces one the vendor
   * no longer has. Only an agent's own token has a dialog to ask for.
   */
  @Post('dialog/handback')
  @HttpCode(200)
  async handback(
    @Req() req: Caller,
    @Body() body?: Record<string, unknown>,
  ): Promise<{ text: string | null }> {
    if (!req.agentScope)
      throw new ForbiddenException('for an agent session only');
    return {
      text: await this.dialog.handback(
        req.agentScope.agentId,
        body?.on === 'request' || body?.on === 'start' || body?.on === 'resume'
          ? body.on
          : 'compact',
      ),
    };
  }
}
