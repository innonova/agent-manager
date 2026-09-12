import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { MANAGER_CONFIG } from '../config/config.js';
import type { ManagerConfig } from '../config/config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  default_profile TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  profile TEXT NOT NULL,
  cwd TEXT NOT NULL,
  vendor_conversation_id TEXT,
  current_session_id TEXT,
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE TABLE IF NOT EXISTS agent_sessions (
  daemon_session_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS agent_sessions_agent ON agent_sessions(agent_id);
CREATE TABLE IF NOT EXISTS feature_queue (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  queued_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, slug)
);
CREATE TABLE IF NOT EXISTS feature_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS feature_runs_open ON feature_runs(agent_id, ended_at);
`;

/** The SQLite handle plus schema setup. Queries live in the services that own the tables. */
@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  db!: Database.Database;

  constructor(@Inject(MANAGER_CONFIG) private readonly config: ManagerConfig) {}

  onModuleInit(): void {
    fs.mkdirSync(this.config.dataDir, { recursive: true });
    this.db = new Database(path.join(this.config.dataDir, 'manager.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  onModuleDestroy(): void {
    this.db?.close();
  }
}
