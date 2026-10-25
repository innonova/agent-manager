import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { User } from '../auth/auth.service.js';
import { PushService } from './push.service.js';

/** Web push: the install's public key, a browser's subscription, and a test to see it arrive. Login sessions only (an agent token has no browser). */
@Controller('api/push')
export class PushController {
  constructor(private readonly push: PushService) {}

  @Get('key')
  key(): { publicKey: string } {
    return { publicKey: this.push.publicKey() };
  }

  @Post('subscriptions')
  subscribe(
    @Req() req: Request & { user?: User },
    @Body() body: { subscription?: unknown },
  ): { count: number } {
    return this.push.subscribe(
      req.user!.id,
      body?.subscription,
      typeof req.headers['user-agent'] === 'string'
        ? req.headers['user-agent'].slice(0, 200)
        : null,
    );
  }

  /** The endpoint as a query parameter: a DELETE with a body is not something every client sends. */
  @Delete('subscriptions')
  unsubscribe(
    @Req() req: Request & { user?: User },
    @Query('endpoint') endpoint?: string,
  ): { count: number } {
    return this.push.unsubscribe(req.user!.id, endpoint);
  }

  /** Sends "this is a test" to the caller's own subscriptions; the reply says how many went. */
  @Post('test')
  async test(@Req() req: Request & { user?: User }): Promise<{ sent: number }> {
    return {
      sent: await this.push.notify(req.user!.id, {
        title: 'agent-manager: this is a test',
        body: 'Notifications reach this device.',
        url: '/',
        tag: 'test',
      }),
    };
  }
}
