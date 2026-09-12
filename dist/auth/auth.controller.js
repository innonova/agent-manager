var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import { Body, Controller, Get, Inject, Post, Req, Res, UnauthorizedException, } from '@nestjs/common';
import { stringifySetCookie } from 'cookie';
import { MANAGER_CONFIG } from '../config/config.js';
import { COOKIE_NAME, Public } from './auth.guard.js';
import { AuthService } from './auth.service.js';
let AuthController = class AuthController {
    config;
    auth;
    constructor(config, auth) {
        this.config = config;
        this.auth = auth;
    }
    async login(body, req, res) {
        if (typeof body?.name !== 'string' || typeof body?.password !== 'string')
            throw new UnauthorizedException('invalid credentials');
        const { user, sessionId } = await this.auth.login(body.name, body.password, req.ip ?? req.socket.remoteAddress ?? 'unknown');
        res.setHeader('Set-Cookie', stringifySetCookie({
            name: COOKIE_NAME,
            value: sessionId,
            httpOnly: true,
            sameSite: 'lax',
            secure: this.config.secureCookie,
            path: '/',
            maxAge: Math.floor(this.config.sessionTtlMs / 1000),
        }));
        return { user };
    }
    logout(req, res) {
        if (req.sessionId)
            this.auth.logout(req.sessionId);
        res.setHeader('Set-Cookie', stringifySetCookie({
            name: COOKIE_NAME,
            value: '',
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
            maxAge: 0,
        }));
        return { ok: true };
    }
    me(req) {
        return { user: req.user };
    }
};
__decorate([
    Public(),
    Post('login'),
    __param(0, Body()),
    __param(1, Req()),
    __param(2, Res({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "login", null);
__decorate([
    Post('logout'),
    __param(0, Req()),
    __param(1, Res({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Object)
], AuthController.prototype, "logout", null);
__decorate([
    Get('me'),
    __param(0, Req()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Object)
], AuthController.prototype, "me", null);
AuthController = __decorate([
    Controller('api/auth'),
    __param(0, Inject(MANAGER_CONFIG)),
    __metadata("design:paramtypes", [Object, AuthService])
], AuthController);
export { AuthController };
//# sourceMappingURL=auth.controller.js.map