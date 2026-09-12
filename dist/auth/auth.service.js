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
import { HttpException, Inject, Injectable, Logger, UnauthorizedException, } from '@nestjs/common';
import argon2 from 'argon2';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { MANAGER_CONFIG } from '../config/config.js';
import { DbService } from '../db/db.service.js';
const VERIFY_CONCURRENCY = 4;
let AuthService = AuthService_1 = class AuthService extends EventEmitter {
    config;
    dbs;
    logger = new Logger(AuthService_1.name);
    attempts = new Map();
    verifying = 0;
    verifyQueue = [];
    dummyHash = '';
    constructor(config, dbs) {
        super();
        this.config = config;
        this.dbs = dbs;
    }
    get db() {
        return this.dbs.db;
    }
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
    async login(name, password, clientKey = 'unknown') {
        this.throttle(clientKey);
        const row = this.db
            .prepare('SELECT * FROM users WHERE name = ?')
            .get(name);
        const ok = await this.verify(row ? row.password_hash : this.dummyHash, password);
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
        this.emit('revoked', sessionId);
    }
    userForSession(sessionId) {
        if (!sessionId)
            return null;
        const row = this.db
            .prepare('SELECT u.* FROM login_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?')
            .get(sessionId, Date.now());
        return row ? toUser(row) : null;
    }
    throttle(key) {
        const now = Date.now();
        let a = this.attempts.get(key);
        if (!a || a.resetAt <= now) {
            a = { count: 0, resetAt: now + 60_000 };
            this.attempts.set(key, a);
        }
        if (++a.count > this.config.loginAttemptsPerMinute)
            throw new HttpException('too many login attempts; try again in a minute', 429);
        if (this.attempts.size > 10_000)
            for (const [k, v] of this.attempts)
                if (v.resetAt <= now)
                    this.attempts.delete(k);
    }
    async verify(hash, password) {
        if (this.verifying >= VERIFY_CONCURRENCY)
            await new Promise((r) => this.verifyQueue.push(r));
        this.verifying++;
        try {
            return await argon2.verify(hash, password);
        }
        catch {
            return false;
        }
        finally {
            this.verifying--;
            this.verifyQueue.shift()?.();
        }
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