import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
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
  lastLoginAt: number | null;
}

interface UserRow {
  id: string;
  name: string;
  password_hash: string;
  created_at: number;
  last_login_at: number | null;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Unambiguous, typeable: no 0/O, 1/l/I. Four groups of four is ~79 bits. */
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function generatePassword(): string {
  const bytes = randomBytes(16);
  const chars = [...bytes].map(
    (b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length],
  );
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

const VERIFY_CONCURRENCY = 4;

/**
 * Users and login sessions. Session ids are opaque 256-bit random tokens
 * checked against the database on every request; logout deletes the row
 * and tells listeners (the events gateway) so open sockets are closed.
 */
@Injectable()
export class AuthService
  extends EventEmitter<{ revoked: [sessionId: string]; users: [users: User[]] }>
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AuthService.name);
  private readonly attempts = new Map<
    string,
    { count: number; resetAt: number }
  >();
  private verifying = 0;
  private readonly verifyQueue: (() => void)[] = [];
  private dummyHash = '';
  private cleanup: NodeJS.Timeout | null = null;

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
    this.cleanup = setInterval(
      () =>
        this.db
          .prepare('DELETE FROM login_sessions WHERE expires_at < ?')
          .run(Date.now()),
      3600_000,
    );
    this.cleanup.unref();
  }

  onModuleDestroy(): void {
    if (this.cleanup) clearInterval(this.cleanup);
  }

  async createUser(name: string, password: string): Promise<User> {
    if (!NAME_RE.test(name))
      throw new BadRequestException(
        'name must be letters, digits, dot, dash or underscore, up to 64',
      );
    if (this.db.prepare('SELECT 1 FROM users WHERE name = ?').get(name))
      throw new ConflictException(`a user named ${name} exists`);
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const user: User = {
      id: randomUUID(),
      name,
      createdAt: Date.now(),
      lastLoginAt: null,
    };
    this.db
      .prepare(
        'INSERT INTO users (id, name, password_hash, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(user.id, name, hash, user.createdAt);
    this.emit('users', this.listUsers());
    return user;
  }

  // ---- accounts: every user is a trusted admin --------------------------------

  listUsers(): User[] {
    return (
      this.db
        .prepare('SELECT * FROM users ORDER BY created_at')
        .all() as UserRow[]
    ).map(toUser);
  }

  getUser(id: string): User {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
      UserRow | undefined;
    if (!row) throw new NotFoundException('no such user');
    return toUser(row);
  }

  /** Creates an account with a generated password, returned once and never stored in the clear. */
  async createAccount(
    name: unknown,
  ): Promise<{ user: User; password: string }> {
    if (typeof name !== 'string')
      throw new BadRequestException('"name" is required');
    const password = generatePassword();
    const user = await this.createUser(name.trim(), password);
    return { user, password };
  }

  renameUser(id: string, name: unknown): User {
    if (typeof name !== 'string' || !NAME_RE.test(name.trim()))
      throw new BadRequestException(
        'name must be letters, digits, dot, dash or underscore, up to 64',
      );
    const clean = name.trim();
    const clash = this.db
      .prepare('SELECT id FROM users WHERE name = ? AND id != ?')
      .get(clean, id);
    if (clash) throw new ConflictException(`a user named ${clean} exists`);
    const r = this.db
      .prepare('UPDATE users SET name = ? WHERE id = ?')
      .run(clean, id);
    if (r.changes === 0) throw new NotFoundException('no such user');
    this.emit('users', this.listUsers());
    return this.getUser(id);
  }

  /**
   * A new generated password for any user (everyone is an admin); their
   * other login sessions end so a forgotten password cannot linger as a
   * live session elsewhere. `keepSessionId` spares the caller's own
   * session when resetting themselves.
   */
  async resetPassword(
    id: string,
    keepSessionId?: string,
    byUserId?: string,
  ): Promise<string> {
    this.getUser(id);
    const password = generatePassword();
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    this.db
      .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .run(hash, id);
    this.revokeSessions(id, keepSessionId);
    this.logger.log(
      `password reset for user ${id}${byUserId ? ` by ${byUserId}` : ''}`,
    );
    this.emit('users', this.listUsers());
    return password;
  }

  deleteUser(id: string, callerId: string): void {
    if (id === callerId)
      throw new ConflictException('you cannot remove yourself');
    this.getUser(id);
    const n = (
      this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
    ).n;
    if (n <= 1) throw new ConflictException('the last user cannot be removed');
    this.revokeSessions(id);
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    this.emit('users', this.listUsers());
  }

  private revokeSessions(userId: string, keepSessionId?: string): void {
    const rows = this.db
      .prepare('SELECT id FROM login_sessions WHERE user_id = ?')
      .all(userId) as { id: string }[];
    for (const { id } of rows) {
      if (id === keepSessionId) continue;
      this.db.prepare('DELETE FROM login_sessions WHERE id = ?').run(id);
      this.emit('revoked', id);
    }
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
    // Verification takes a moment; a reset meanwhile must win.
    const current = this.db
      .prepare('SELECT password_hash FROM users WHERE id = ?')
      .get(row.id) as { password_hash: string } | undefined;
    if (!current || current.password_hash !== row.password_hash)
      throw new UnauthorizedException('invalid credentials');
    const sessionId = randomBytes(32).toString('base64url');
    this.db
      .prepare(
        'INSERT INTO login_sessions (id, user_id, expires_at) VALUES (?, ?, ?)',
      )
      .run(sessionId, row.id, Date.now() + this.config.sessionTtlMs);
    this.db
      .prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
      .run(Date.now(), row.id);
    return { user: toUser({ ...row, last_login_at: Date.now() }), sessionId };
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
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at ?? null,
  };
}
