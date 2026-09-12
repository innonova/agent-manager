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
var AuthService_1;
import { Inject, Injectable, Logger, UnauthorizedException, } from '@nestjs/common';
import argon2 from 'argon2';
import { randomBytes, randomUUID } from 'node:crypto';
import { MANAGER_CONFIG } from '../config/config.js';
import { DbService } from '../db/db.service.js';
let AuthService = AuthService_1 = class AuthService {
    config;
    dbs;
    logger = new Logger(AuthService_1.name);
    constructor(config, dbs) {
        this.config = config;
        this.dbs = dbs;
    }
    get db() {
        return this.dbs.db;
    }
    dummyHash = '';
    async onModuleInit() {
        this.dummyHash = await argon2.hash(randomBytes(16).toString('hex'), {
            type: argon2.argon2id,
        });
        const count = this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
        if (count === 0 && this.config.adminPassword) {
            await this.createUser('admin', this.config.adminPassword);
            this.logger.log('created initial user "admin" from AGENT_MANAGER_ADMIN_PASSWORD');
        }
        else if (count === 0) {
            this.logger.warn('no users exist; set AGENT_MANAGER_ADMIN_PASSWORD or run the user:add script');
        }
        this.db
            .prepare('DELETE FROM login_sessions WHERE expires_at < ?')
            .run(Date.now());
    }
    async createUser(name, password) {
        const hash = await argon2.hash(password, { type: argon2.argon2id });
        const user = { id: randomUUID(), name, createdAt: Date.now() };
        this.db
            .prepare('INSERT INTO users (id, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
            .run(user.id, name, hash, user.createdAt);
        return user;
    }
    async login(name, password) {
        const row = this.db
            .prepare('SELECT * FROM users WHERE name = ?')
            .get(name);
        const ok = row
            ? await argon2.verify(row.password_hash, password)
            : await argon2.verify(this.dummyHash, password);
        if (!row || !ok)
            throw new UnauthorizedException('invalid credentials');
        const sessionId = randomBytes(32).toString('base64url');
        this.db
            .prepare('INSERT INTO login_sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
            .run(sessionId, row.id, Date.now() + this.config.sessionTtlMs);
        return { user: toUser(row), sessionId };
    }
    logout(sessionId) {
        this.db.prepare('DELETE FROM login_sessions WHERE id = ?').run(sessionId);
    }
    userForSession(sessionId) {
        if (!sessionId)
            return null;
        const row = this.db
            .prepare('SELECT u.* FROM login_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?')
            .get(sessionId, Date.now());
        return row ? toUser(row) : null;
    }
};
AuthService = AuthService_1 = __decorate([
    Injectable(),
    __param(0, Inject(MANAGER_CONFIG)),
    __metadata("design:paramtypes", [Object, DbService])
], AuthService);
export { AuthService };
function toUser(row) {
    return { id: row.id, name: row.name, createdAt: row.created_at };
}
//# sourceMappingURL=auth.service.js.map