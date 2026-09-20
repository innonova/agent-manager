import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthService, User } from './auth.service.js';

export { COOKIE_NAME, sessionIdFromCookieHeader } from './cookie.js';
export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

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
    const { user, sessionId, scope } = this.auth.userForHeaders(req.headers);
    if (!user) throw new UnauthorizedException();
    if (
      scope &&
      !this.auth.scopeAllows(scope, req.method, req.baseUrl + req.path)
    )
      throw new ForbiddenException("outside this agent token's project");
    req.user = user;
    req.sessionId = sessionId ?? undefined;
    return true;
  }
}
