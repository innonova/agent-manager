import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AgentScope, User } from '../auth/auth.service.js';
import {
  ChatMessage,
  ChatService,
  ChatSummary,
  ChatVia,
} from './chat.service.js';

type Caller = Request & { user?: User; agentScope?: AgentScope };

/**
 * An agent's chat. Who is calling decides which side speaks: the
 * agent's own session token is the agent, anyone else (a person, or
 * another agent) is talking to it.
 */
@Controller('api')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get('agents/:id/chat')
  list(
    @Param('id') id: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ): { messages: ChatMessage[]; summary: ChatSummary } {
    const num = (name: string, v?: string) => {
      if (v === undefined) return undefined;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1)
        throw new BadRequestException(`"${name}" must be a positive integer`);
      return n;
    };
    return this.chat.list(id, {
      before: num('before', before),
      limit: num('limit', limit),
    });
  }

  /**
   * Says something. From the agent itself: `{ text, kind?, important?,
   * replyTo? }`. To the agent: `{ text, replyTo?, steer?, images? }`; the
   * answer's `mode` says how it travelled (`aside`, `turn`, `steer`).
   */
  @Post('agents/:id/chat')
  async say(
    @Req() req: Caller,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ): Promise<{ message: ChatMessage; mode?: ChatVia }> {
    if (req.agentScope?.agentId === id)
      return { message: await this.chat.agentSays(id, body ?? {}) };
    return this.chat.personSays(
      id,
      { id: req.user!.id, name: req.user!.name },
      body ?? {},
    );
  }

  /** The agent reads what is unread, which marks it read; nobody else's fetch is a reading. */
  @Post('agents/:id/chat/read')
  @HttpCode(200)
  read(
    @Req() req: Caller,
    @Param('id') id: string,
  ): { messages: ChatMessage[]; summary: ChatSummary } {
    if (req.agentScope?.agentId !== id)
      throw new ForbiddenException('only the agent itself reads its chat');
    return this.chat.read(id);
  }

  /** Closes an open question: the agent no longer needs the answer, or a person dismisses it. */
  @Post('agents/:id/chat/:messageId/close')
  @HttpCode(200)
  close(
    @Req() req: Caller,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
  ): { message: ChatMessage } {
    const n = Number(messageId);
    if (!Number.isInteger(n))
      throw new BadRequestException('the message id is a number');
    return {
      message: this.chat.close(
        id,
        n,
        req.agentScope?.agentId === id ? 'agent' : 'person',
      ),
    };
  }

  /** Per agent of the project: unread messages, open questions, the newest message. */
  @Get('projects/:projectId/chat')
  projectSummary(
    @Param('projectId') projectId: string,
  ): Record<string, ChatSummary> {
    return this.chat.projectSummary(projectId);
  }

  /** An agent's hook asking whether to say that chat messages are unread; only an agent's own token has a chat to ask about. */
  @Post('chat/notice')
  @HttpCode(200)
  notice(@Req() req: Caller): { text: string | null } {
    if (!req.agentScope)
      throw new ForbiddenException('for an agent session only');
    return this.chat.notice(req.agentScope.agentId);
  }
}
