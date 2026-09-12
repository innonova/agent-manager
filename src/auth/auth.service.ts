import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import argon2 from 'argon2';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { MANAGER_CONFIG } from '../config/config.js';
import type { ManagerConfig } from '../config/config.js';
import { DbService } from '../db/db.service.js';

export interface User {
  id: string;
  name: string;
  createdAt: number;
}

interface UserRow {
  id: string;
  name: string;
  password_hash: string;
  created_at: number;
}

const VERIFY_CONCURRENCY = 4;

/**
 * Users and login sessions. Session ids are opaque 256-bit random tokens
 * checked against the database on every request; logout deletes the row
 * and tells listeners (the events gateway) so open sockets are closed.
 */
@Injectable()
export class AuthService
  extends EventEmitter<{ revoked: [sessionId: string] }>
  implements OnModuleInit
{
  private readonly logger = new Logger(AuthService.name);
  private readonly attempts = new Map<
    string,
    { count: number; resetAt: number }
  >();
  private verifying = 0;
  private readonly verifyQueue: (() => void)[] = [];
  private dummyHash = '';

  constructor(
    @Inject(MANAGER_CONFIG) private readonly config: ManagerConfig,
    private readonly dbs: DbService,
  ) {
    super();
  }

  private get db() {
    return this.dbs.db;
  }

  async onModuleInit(): Promise<void> {
    // A real hash of a random secret, used to equalise timing for unknown users.
    this.dummyHash = await argon2.hash(randomBytes(16).toString('hex'), {
      type: argon2.argon2id,
    });
    const count = (
      this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
    ).n;
    if (count === 0 && this.config.adminPassword) {
      await this.createUser('admin', this.config.adminPassword);
      this.logger.log(
        'created initial user "admin" from AGENT_MANAGER_ADMIN_PASSWORD',
      );
    } else if (count === 0) {
      this.logger.warn(
        'no users exist; set AGENT_MANAGER_ADMIN_PASSWORD or run the user:add script',
      );
    }
    this.db
      .prepare('DELETE FROM login_sessions WHERE expires_at < ?')
      .run(Date.now());
  }

  async createUser(name: string, password: string): Promise<User> {
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const user = { id: randomUUID(), name, createdAt: Date.now() };
    this.db
      .prepare(
        'INSERT INTO users (id, name, password_hash, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(user.id, name, hash, user.createdAt);
    return user;
  }

  /**
   * Verifies credentials and opens a login session. Attempts are limited
   * per client address and Argon2 work is bounded, with unknown users
   * costing the same as known ones.
   */
  async login(
    name: string,
    password: string,
    clientKey = 'unknown',
  ): Promise<{ user: User; sessionId: string }> {
    this.throttle(clientKey);
    const row = this.db
      .prepare('SELECT * FROM users WHERE name = ?')
      .get(name) as UserRow | undefined;
    const ok = await this.verify(
      row ? row.password_hash : this.dummyHash,
      password,
    );
    if (!row || !ok) throw new UnauthorizedException('invalid credentials');
    const sessionId = randomBytes(32).toString('base64url');
    this.db
      .prepare(
        'INSERT INTO login_sessions (id, user_id, expires_at) VALUES (?, ?, ?)',
      )
      .run(sessionId, row.id, Date.now() + this.config.sessionTtlMs);
    return { user: toUser(row), sessionId };
  }

  logout(sessionId: string): void {
    this.db.prepare('DELETE FROM login_sessions WHERE id = ?').run(sessionId);
    this.emit('revoked', sessionId);
  }

  /** The user behind a login session cookie, or null. */
  userForSession(sessionId: string | undefined): User | null {
    if (!sessionId) return null;
    const row = this.db
      .prepare(
        'SELECT u.* FROM login_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?',
      )
      .get(sessionId, Date.now()) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  private throttle(key: string): void {
    const now = Date.now();
    let a = this.attempts.get(key);
    if (!a || a.resetAt <= now) {
      a = { count: 0, resetAt: now + 60_000 };
      this.attempts.set(key, a);
    }
    if (++a.count > this.config.loginAttemptsPerMinute)
      throw new HttpException(
        'too many login attempts; try again in a minute',
        429,
      );
    if (this.attempts.size > 10_000)
      for (const [k, v] of this.attempts)
        if (v.resetAt <= now) this.attempts.delete(k);
  }

  /** Argon2 verification with a small concurrency bound so a flood cannot starve the process. */
  private async verify(hash: string, password: string): Promise<boolean> {
    if (this.verifying >= VERIFY_CONCURRENCY)
      await new Promise<void>((r) => this.verifyQueue.push(r));
    this.verifying++;
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    } finally {
      this.verifying--;
      this.verifyQueue.shift()?.();
    }
  }
}

function toUser(row: UserRow): User {
  return { id: row.id, name: row.name, createdAt: row.created_at };
}
