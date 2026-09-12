import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { parseCookie } from 'cookie';
import type { Request } from 'express';
import { AuthService, User } from './auth.service.js';

export const COOKIE_NAME = 'am_session';
export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export function sessionIdFromCookieHeader(
  header: string | undefined,
): string | undefined {
  if (!header) return undefined;
  return parseCookie(header)[COOKIE_NAME];
}

/** Global guard: every route needs a valid login session unless marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        ctx.getHandler(),
        ctx.getClass(),
      ])
    )
      return true;
    const req = ctx
      .switchToHttp()
      .getRequest<Request & { user?: User; sessionId?: string }>();
    const sessionId = sessionIdFromCookieHeader(req.headers.cookie);
    const user = this.auth.userForSession(sessionId);
    if (!user) throw new UnauthorizedException();
    req.user = user;
    req.sessionId = sessionId;
    return true;
  }
}
