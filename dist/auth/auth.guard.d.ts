import { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service.js';
export declare const COOKIE_NAME = "am_session";
export declare const IS_PUBLIC = "isPublic";
export declare const Public: () => import("@nestjs/common").CustomDecorator<string>;
export declare function sessionIdFromCookieHeader(header: string | undefined): string | undefined;
export declare class AuthGuard implements CanActivate {
    private readonly reflector;
    private readonly auth;
    constructor(reflector: Reflector, auth: AuthService);
    canActivate(ctx: ExecutionContext): boolean;
}
