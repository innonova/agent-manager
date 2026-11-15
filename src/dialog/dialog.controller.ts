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
  constructor(private readonly dialog: DialogService) {}

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

  /** The hook Claude Code runs after a compaction, asking for the agent's dialog: only an agent's own token has one to ask for. */
  @Post('dialog/handback')
  @HttpCode(200)
  async handback(@Req() req: Caller): Promise<{ text: string | null }> {
    if (!req.agentScope)
      throw new ForbiddenException('for an agent session only');
    return { text: await this.dialog.handback(req.agentScope.agentId) };
  }
}
