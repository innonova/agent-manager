#!/usr/bin/env node
// One-time: attribute every user turn in every known daemon session to one
// user. For installs where there only ever was one user before turn authors
// were recorded. Usage: node scripts/backfill-authors.mjs <user name>
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const name = process.argv[2];
if (!name) {
  console.error('usage: backfill-authors <user name>');
  process.exit(2);
}
const xdgState =
  process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state');
const dataDir =
  process.env.AGENT_MANAGER_DATA_DIR ?? path.join(xdgState, 'agent-manager');
const daemonState =
  process.env.AGENT_DAEMON_STATE_DIR ?? path.join(xdgState, 'agent-daemon');
const db = new Database(path.join(dataDir, 'manager.db'));
const user = db.prepare('SELECT id FROM users WHERE name = ?').get(name);
if (!user) {
  console.error(`no user named ${name}`);
  process.exit(1);
}
const adapters = {
  claude: (await import(path.join(ROOT, 'dist/adapters/claude.adapter.js')))
    .ClaudeAdapter,
  codex: (await import(path.join(ROOT, 'dist/adapters/codex.adapter.js')))
    .CodexAdapter,
  copilot: (await import(path.join(ROOT, 'dist/adapters/copilot.adapter.js')))
    .CopilotAdapter,
  fake: (await import(path.join(ROOT, 'dist/adapters/fake.adapter.js')))
    .FakeAdapter,
};
const insert = db.prepare(
  'INSERT OR IGNORE INTO turn_authors (daemon_session_id, seq, user_id) VALUES (?, ?, ?)',
);
const rows = db
  .prepare(
    'SELECT s.daemon_session_id AS id, a.profile FROM agent_sessions s JOIN agents a ON a.id = s.agent_id',
  )
  .all();
let sessions = 0;
let turns = 0;
for (const { id, profile } of rows) {
  const Adapter = adapters[profile];
  const log = path.join(daemonState, 'sessions', id, 'log.ndjson');
  if (!Adapter || !fs.existsSync(log)) continue;
  const adapter = new Adapter();
  sessions++;
  for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const ing = adapter.ingest(record);
    for (const op of ing.ops ?? [])
      if (op.op === 'append' && op.item.kind === 'user') {
        turns += insert.run(id, record.seq, user.id).changes;
      }
  }
}
console.log(`attributed ${turns} turn(s) in ${sessions} session(s) to ${name}`);
