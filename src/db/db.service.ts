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
  delegation TEXT NOT NULL DEFAULT 'free',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_repos (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (project_id, name)
);
-- Which turn of which agent made a commit, recorded when the vendor
-- reports it (Claude only). Keyed on repo and hash; the commits list
-- joins it ahead of the run window, and it survives a transcript rebuild
-- because item indexes are stable per session.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS commit_attributions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  hash TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  session_id TEXT NOT NULL,
  item_index INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (project_id, repo, hash)
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
-- Where each clone of a stream stood when a run began and when it ended:
-- a stream's feature is in its folder, and its work is in its clones.
CREATE TABLE IF NOT EXISTS run_clones (
  run_id TEXT NOT NULL,
  clone TEXT NOT NULL,
  base_commit TEXT,
  end_commit TEXT,
  PRIMARY KEY (run_id, clone)
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
  transcript_file TEXT,
  -- how the reviewer judged the work, and when sent back, whose gap it was
  -- the feature has left in-progress and the run is waiting for the end of
  -- the turn that did it, so the cost and the commit exist before it closes
  closing_status TEXT,
  closing_at INTEGER,
  review_outcome TEXT,
  review_cause TEXT,
  review_note TEXT,
  reviewed_by TEXT,
  reviewed_at INTEGER
);
-- The chat between people and one agent: its own record, not a view of
-- the transcript. What a person said (an aside to a working agent, a
-- turn, a steer) and what the agent said with its tool (a message, a
-- decision, a question). read_at is when the agent got a person's
-- message; a question is open until closed_at.
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  from_agent INTEGER NOT NULL,
  author_id TEXT,
  author_name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'message',
  important INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  reply_to INTEGER,
  via TEXT,
  images INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  closed_at INTEGER,
  closed_by TEXT
);
CREATE INDEX IF NOT EXISTS chat_agent ON chat_messages (agent_id, id);
CREATE TABLE IF NOT EXISTS agent_nudges (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  last_at INTEGER NOT NULL,
  in_row INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dialog_windows (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  size INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS repositories (
  name TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  setup TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dialog_inherited (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  from_agent TEXT NOT NULL,
  upto INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dialog_owed (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dialog_weights (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  kind TEXT NOT NULL,
  weight INTEGER NOT NULL,
  in_force INTEGER NOT NULL,
  superseded_by INTEGER,
  line TEXT NOT NULL,
  classified_at INTEGER NOT NULL,
  model TEXT NOT NULL,
  PRIMARY KEY (agent_id, n)
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
    if (!agentCols.includes('hold_until'))
      this.db.exec('ALTER TABLE agents ADD COLUMN hold_until INTEGER');
    if (!agentCols.includes('nudge'))
      this.db.exec(
        'ALTER TABLE agents ADD COLUMN nudge INTEGER NOT NULL DEFAULT 0',
      );
    if (!agentCols.includes('host'))
      this.db.exec('ALTER TABLE agents ADD COLUMN host TEXT');
    // A fork: the agent it was copied from; the conversation its first
    // session begins as a copy of (until it has one of its own); the copy
    // of that conversation's file made for it, to remove then; and whether
    // it has yet to be told that it is a fork.
    for (const [name, type] of [
      ['fork_of', 'TEXT'],
      ['fork_conversation', 'TEXT'],
      ['fork_copy', 'TEXT'],
      ['fork_notice', 'TEXT'],
      // what an agent is told at its next start about its stream having been away: one per absence, replaced if written again
      ['away_notice', 'TEXT'],
    ])
      if (!agentCols.includes(name!))
        this.db.exec(`ALTER TABLE agents ADD COLUMN ${name} ${type}`);
    // What a rebase keeps of a commit (when its work was first committed,
    // and its subject), so that the turn that made it is still known once
    // landing has given it another hash.
    const attributionCols = (
      this.db.prepare('PRAGMA table_info(commit_attributions)').all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    if (!attributionCols.includes('author_at')) {
      this.db.exec(
        'ALTER TABLE commit_attributions ADD COLUMN author_at INTEGER',
      );
      this.db.exec('ALTER TABLE commit_attributions ADD COLUMN subject TEXT');
    }
    // The session in which the agent's hook last asked about its chat: an
    // agent with a hook is told of unread messages there, one without by a steer.
    if (!agentCols.includes('hook_session'))
      this.db.exec('ALTER TABLE agents ADD COLUMN hook_session TEXT');
    // The review of a run, added after the runs table shipped.
    const runCols = (
      this.db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]
    ).map((c) => c.name);
    for (const [name, type] of [
      ['closing_status', 'TEXT'],
      ['closing_at', 'INTEGER'],
      ['review_outcome', 'TEXT'],
      ['review_cause', 'TEXT'],
      ['review_note', 'TEXT'],
      ['reviewed_by', 'TEXT'],
      ['reviewed_at', 'INTEGER'],
    ])
      if (!runCols.includes(name!))
        this.db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`);
    if (!agentCols.includes('permissions'))
      this.db.exec(
        "ALTER TABLE agents ADD COLUMN permissions TEXT NOT NULL DEFAULT 'bypass'",
      );
    // Per-project delegation rule, added after projects shipped.
    const projectCols = (
      this.db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]
    ).map((c) => c.name);
    if (!projectCols.includes('delegation'))
      this.db.exec(
        "ALTER TABLE projects ADD COLUMN delegation TEXT NOT NULL DEFAULT 'free'",
      );
    // A stream is a project of another kind: the same identity for agents,
    // tokens and chats, with a home of its own instead of a list of repositories.
    if (!projectCols.includes('kind'))
      this.db.exec(
        "ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'project'",
      );
    // A label the tree groups projects and streams under; null is ungrouped.
    if (!projectCols.includes('group_name'))
      this.db.exec('ALTER TABLE projects ADD COLUMN group_name TEXT');
    // A stream put away: `archiving`, `archived` or `reviving`, and since when.
    if (!projectCols.includes('archive_state')) {
      this.db.exec('ALTER TABLE projects ADD COLUMN archive_state TEXT');
      this.db.exec('ALTER TABLE projects ADD COLUMN archive_at INTEGER');
    }
    // Projects created before repos existed: their path becomes the single
    // repo. Not a stream's: its path is its home, and it has no such list.
    const legacy = this.db
      .prepare(
        "SELECT id, path FROM projects WHERE kind != 'stream' AND id NOT IN (SELECT project_id FROM project_repos)",
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
