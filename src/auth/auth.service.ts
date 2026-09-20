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
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { sessionIdFromCookieHeader } from './cookie.js';
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

/** What an agent's session token is allowed to touch. */
export interface AgentScope {
  agentId: string;
  projectId: string;
}
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    const row = this.db
      .prepare('SELECT password_hash FROM users WHERE id = ?')
      .get(id) as { password_hash: string } | undefined;
    if (row?.password_hash.startsWith('hub:'))
      throw new ConflictException(
        'this user was created by a hub and logs in there; it has no password here',
      );
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
  /**
   * Who a request is from: the login cookie's session, or, for a hub
   * fronting for this manager, its bearer token plus the name of the
   * person acting through it (created here on first sight, without a
   * password of their own).
   */
  userForHeaders(headers: {
    cookie?: string;
    authorization?: string;
    'x-acting-user'?: string | string[];
  }): { user: User | null; sessionId: string | null; scope?: AgentScope } {
    const sessionId = sessionIdFromCookieHeader(headers.cookie);
    const fromCookie = this.userForSession(sessionId);
    if (fromCookie) return { user: fromCookie, sessionId: sessionId ?? null };
    const auth = headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return { user: null, sessionId: null };
    const scope = this.agentForToken(token);
    if (scope) {
      // an agent's own session token: it acts as a user named after it
      const agent = this.db
        .prepare('SELECT name FROM agents WHERE id = ?')
        .get(scope.agentId) as { name: string } | undefined;
      if (!agent) return { user: null, sessionId: null };
      return {
        user: this.actingUser(`agent-${agent.name}`.slice(0, 64)),
        sessionId: null,
        scope,
      };
    }
    if (
      !this.config.hubToken ||
      !timingSafeEqualStr(token, this.config.hubToken)
    )
      return { user: null, sessionId: null };
    const acting = headers['x-acting-user'];
    const name = typeof acting === 'string' ? acting.trim() : '';
    if (!NAME_RE.test(name)) return { user: null, sessionId: null };
    return { user: this.actingUser(name), sessionId: null };
  }

  /**
   * A token for an agent's session, so its `am` can reach this manager
   * (AGENT_MANAGER_TOKEN in the process environment). Scoped to the
   * agent's project; only the hash is kept. Replaced at every session
   * start, gone with the agent.
   */
  issueAgentToken(agentId: string, projectId: string): string {
    const token = randomBytes(32).toString('hex');
    this.db.prepare('DELETE FROM agent_tokens WHERE agent_id = ?').run(agentId);
    this.db
      .prepare(
        'INSERT INTO agent_tokens (token_hash, agent_id, project_id, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(hashToken(token), agentId, projectId, Date.now());
    return token;
  }

  revokeAgentTokens(agentId: string): void {
    this.db.prepare('DELETE FROM agent_tokens WHERE agent_id = ?').run(agentId);
  }

  private agentForToken(token: string): AgentScope | null {
    if (!/^[0-9a-f]{64}$/.test(token)) return null;
    const row = this.db
      .prepare(
        'SELECT agent_id, project_id FROM agent_tokens WHERE token_hash = ?',
      )
      .get(hashToken(token)) as
      { agent_id: string; project_id: string } | undefined;
    return row ? { agentId: row.agent_id, projectId: row.project_id } : null;
  }

  /**
   * What an agent's token may do: read and act within its own project
   * (its agents, features, files, profiles) and nothing about users, other
   * projects, the harness template or the project's own settings. A
   * guardrail against a helper wandering, not a security boundary: the
   * process runs as the same user as the manager.
   */
  scopeAllows(scope: AgentScope, method: string, path: string): boolean {
    const p = path.replace(/\?.*$/, '');
    if (p === '/api/auth/me' || p === '/api/health' || p === '/api/profiles')
      return true;
    if (p === '/api/events') return true;
    if (p === '/api/projects' && method === 'GET') return true;
    const inProject = new RegExp(
      `^/api/projects/${escapeRe(scope.projectId)}(/|$)`,
    );
    if (inProject.test(p)) {
      const rest = p.slice(`/api/projects/${scope.projectId}`.length);
      if (rest === '' || rest === '/') return method === 'GET';
      if (rest === '/agents/restart') return false;
      return true; // agents, features, files, profiles, uploads of its own project
    }
    // the run log of its own project: the list filtered to it, and a run of it
    if (p === '/api/runs') {
      const q = new URLSearchParams(path.slice(path.indexOf('?') + 1));
      return (
        method === 'GET' &&
        path.includes('?') &&
        q.get('project') === scope.projectId
      );
    }
    const run = /^\/api\/runs\/([^/]+)$/.exec(p);
    if (run) {
      const row = this.db
        .prepare('SELECT project_id FROM runs WHERE id = ?')
        .get(decodeURIComponent(run[1]!)) as { project_id: string } | undefined;
      return method === 'GET' && row?.project_id === scope.projectId;
    }
    const m = /^\/api\/agents\/([^/]+)(\/|$)/.exec(p);
    if (m) {
      const row = this.db
        .prepare('SELECT project_id FROM agents WHERE id = ?')
        .get(decodeURIComponent(m[1]!)) as { project_id: string } | undefined;
      return row?.project_id === scope.projectId;
    }
    return false;
  }

  /** The user of that name, created with an unusable password if new. */
  private actingUser(name: string): User {
    const row = this.db
      .prepare('SELECT * FROM users WHERE name = ?')
      .get(name) as UserRow | undefined;
    if (row) return toUser(row);
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
      .run(user.id, name, `hub:${randomUUID()}`, user.createdAt); // never a valid argon2 hash: cannot log in directly
    this.logger.log(`user ${name} created for a hub`);
    this.emit('users', this.listUsers());
    return user;
  }

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

function timingSafeEqualStr(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
