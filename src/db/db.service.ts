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
CREATE TABLE IF NOT EXISTS project_repos (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (project_id, name)
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
CREATE TABLE IF NOT EXISTS agent_tokens (
  token_hash TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
DROP TABLE IF EXISTS feature_queue;
DROP TABLE IF EXISTS feature_runs;
CREATE TABLE IF NOT EXISTS turn_authors (
  daemon_session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (daemon_session_id, seq)
);
CREATE TABLE IF NOT EXISTS read_cursors (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, project_id, repo)
);
CREATE TABLE IF NOT EXISTS feature_ranges (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  repo TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  end_commit TEXT,
  PRIMARY KEY (project_id, slug, repo)
);
-- One agent's work on one feature. Deliberately without foreign keys and
-- with the agent's identity copied in: the log is the point after the
-- agent, and even the project, is forgotten.
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  host TEXT NOT NULL,
  repo TEXT NOT NULL,
  slug TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  profile TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  permissions TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  feature_status TEXT,
  outcome TEXT,
  base_commit TEXT,
  end_commit TEXT,
  turns INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  item_from INTEGER NOT NULL,
  item_to INTEGER,
  -- the vendor's running totals when the run began, so the close can
  -- report the difference after a restart of the manager
  start_spend TEXT,
  report TEXT,
  transcript_file TEXT
);
CREATE INDEX IF NOT EXISTS runs_project ON runs (project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS runs_open ON runs (agent_id) WHERE ended_at IS NULL;
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
    // Columns added after the first release; CREATE TABLE IF NOT EXISTS does not add them.
    const agentCols = (
      this.db.prepare('PRAGMA table_info(agents)').all() as { name: string }[]
    ).map((c) => c.name);
    const userCols = (
      this.db.prepare('PRAGMA table_info(users)').all() as { name: string }[]
    ).map((c) => c.name);
    if (!userCols.includes('last_login_at'))
      this.db.exec('ALTER TABLE users ADD COLUMN last_login_at INTEGER');
    if (!agentCols.includes('model'))
      this.db.exec('ALTER TABLE agents ADD COLUMN model TEXT');
    if (!agentCols.includes('effort'))
      this.db.exec('ALTER TABLE agents ADD COLUMN effort TEXT');
    if (!agentCols.includes('harness_note'))
      this.db.exec('ALTER TABLE agents ADD COLUMN harness_note TEXT');
    if (!agentCols.includes('created_by'))
      this.db.exec('ALTER TABLE agents ADD COLUMN created_by TEXT');
    if (!agentCols.includes('permissions'))
      this.db.exec(
        "ALTER TABLE agents ADD COLUMN permissions TEXT NOT NULL DEFAULT 'bypass'",
      );
    // Projects created before repos existed: their path becomes the single repo.
    const legacy = this.db
      .prepare(
        'SELECT id, path FROM projects WHERE id NOT IN (SELECT project_id FROM project_repos)',
      )
      .all() as { id: string; path: string }[];
    const insert = this.db.prepare(
      'INSERT INTO project_repos (project_id, name, path, position) VALUES (?, ?, ?, 0)',
    );
    for (const p of legacy)
      insert.run(p.id, path.basename(p.path) || 'repo', p.path);
  }

  onModuleDestroy(): void {
    this.db?.close();
  }
}
