import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { User } from '../auth/auth.service.js';
import { NudgeService } from './nudge.service.js';

@Controller('api')
export class NudgeController {
  constructor(private readonly nudge: NudgeService) {}

  /** Calls off the nudge that is pending for an agent: the caller is here and will say what happens next. `held` says whether anything was pending. */
  @Post('agents/:id/nudge/hold')
  @HttpCode(200)
  hold(
    @Req() req: Request & { user?: User },
    @Param('id') id: string,
  ): { ok: true; held: boolean } {
    return { ok: true, held: this.nudge.hold(id, req.user?.name ?? 'someone') };
  }
}
