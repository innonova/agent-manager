import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { stringifySetCookie } from 'cookie';
import { MANAGER_CONFIG } from '../config/config.js';
import type { ManagerConfig } from '../config/config.js';
import { COOKIE_NAME, Public } from './auth.guard.js';
import { AuthService, User } from './auth.service.js';

@Controller('api/auth')
export class AuthController {
  constructor(
    @Inject(MANAGER_CONFIG) private readonly config: ManagerConfig,
    private readonly auth: AuthService,
  ) {}

  @Public()
  @Post('login')
  async login(
    @Body() body: { name?: unknown; password?: unknown },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: User }> {
    if (typeof body?.name !== 'string' || typeof body?.password !== 'string')
      throw new UnauthorizedException('invalid credentials');
    const { user, sessionId } = await this.auth.login(
      body.name,
      body.password,
      req.ip ?? req.socket.remoteAddress ?? 'unknown',
    );
    res.setHeader(
      'Set-Cookie',
      stringifySetCookie({
        name: COOKIE_NAME,
        value: sessionId,
        httpOnly: true,
        sameSite: 'lax',
        secure: this.config.secureCookie,
        path: '/',
        maxAge: Math.floor(this.config.sessionTtlMs / 1000),
      }),
    );
    return { user };
  }

  @Post('logout')
  logout(
    @Req() req: Request & { sessionId?: string },
    @Res({ passthrough: true }) res: Response,
  ): { ok: true } {
    if (req.sessionId) this.auth.logout(req.sessionId);
    res.setHeader(
      'Set-Cookie',
      stringifySetCookie({
        name: COOKIE_NAME,
        value: '',
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 0,
      }),
    );
    return { ok: true };
  }

  @Get('me')
  me(@Req() req: Request & { user?: User }): { user: User } {
    return { user: req.user! };
  }
}
