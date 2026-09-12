import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import argon2 from 'argon2';
import { randomBytes, randomUUID } from 'node:crypto';
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

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(MANAGER_CONFIG) private readonly config: ManagerConfig,
    private readonly dbs: DbService,
  ) {}

  private get db() {
    return this.dbs.db;
  }

  private dummyHash = '';

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

  /** Verifies credentials and opens a login session. Returns the cookie value. */
  async login(
    name: string,
    password: string,
  ): Promise<{ user: User; sessionId: string }> {
    const row = this.db
      .prepare('SELECT * FROM users WHERE name = ?')
      .get(name) as UserRow | undefined;
    // Verify against a dummy hash when the user is unknown so timing does not reveal existence.
    const ok = row
      ? await argon2.verify(row.password_hash, password)
      : await argon2.verify(this.dummyHash, password);
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
}

function toUser(row: UserRow): User {
  return { id: row.id, name: row.name, createdAt: row.created_at };
}
