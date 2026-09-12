#!/usr/bin/env node
// Adds a user to the manager database. Usage: node scripts/user-add.mjs <name>
// Prompts for the password (or reads AGENT_MANAGER_NEW_PASSWORD).
import Database from 'better-sqlite3';
import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';

const name = process.argv[2];
if (!name) {
  console.error('usage: user-add <name>');
  process.exit(2);
}
const dataDir =
  process.env.AGENT_MANAGER_DATA_DIR ??
  path.join(
    process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'),
    'agent-manager',
  );
fs.mkdirSync(dataDir, { recursive: true });
let password = process.env.AGENT_MANAGER_NEW_PASSWORD;
if (!password) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  password = await rl.question(`password for ${name}: `);
  rl.close();
}
if (!password) {
  console.error('empty password');
  process.exit(2);
}
const db = new Database(path.join(dataDir, 'manager.db'));
db.exec(
  'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL)',
);
const hash = await argon2.hash(password, { type: argon2.argon2id });
db.prepare(
  'INSERT INTO users (id, name, password_hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET password_hash = excluded.password_hash',
).run(randomUUID(), name, hash, Date.now());
console.log(`user ${name} saved in ${dataDir}/manager.db`);
