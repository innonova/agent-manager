var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Injectable, SetMetadata, UnauthorizedException, } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { parseCookie } from 'cookie';
import { AuthService } from './auth.service.js';
export const COOKIE_NAME = 'am_session';
export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);
export function sessionIdFromCookieHeader(header) {
    if (!header)
        return undefined;
    return parseCookie(header)[COOKIE_NAME];
}
let AuthGuard = class AuthGuard {
    reflector;
    auth;
    constructor(reflector, auth) {
        this.reflector = reflector;
        this.auth = auth;
    }
    canActivate(ctx) {
        if (this.reflector.getAllAndOverride(IS_PUBLIC, [
            ctx.getHandler(),
            ctx.getClass(),
        ]))
            return true;
        const req = ctx
            .switchToHttp()
            .getRequest();
        const sessionId = sessionIdFromCookieHeader(req.headers.cookie);
        const user = this.auth.userForSession(sessionId);
        if (!user)
            throw new UnauthorizedException();
        req.user = user;
        req.sessionId = sessionId;
        return true;
    }
};
AuthGuard = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [Reflector,
        AuthService])
], AuthGuard);
export { AuthGuard };
//# sourceMappingURL=auth.guard.js.map