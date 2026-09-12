#!/usr/bin/env node
// Opt-in end-to-end check through the whole stack with the real agent CLIs.
// Starts a throwaway agent-daemon (real profiles) and a throwaway manager on
// ephemeral ports, creates an agent per profile, sends one turn each and
// checks the answer. Costs tokens on three vendors. Never touches the
// installed services.
//
//   node scripts/smoke-agents.mjs [claude|codex|copilot ...]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAEMON_MAIN =
  process.env.AGENT_DAEMON_MAIN ??
  path.resolve(ROOT, '..', 'agent-daemon', 'dist', 'main.js');
const MANAGER_MAIN = path.join(ROOT, 'dist', 'main.js');
const PROFILES = {
  claude: {
    command: 'claude',
    args: [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--replay-user-messages',
      '--model',
      'claude-haiku-4-5-20251001',
    ],
  },
  codex: { command: 'codex', args: ['app-server'] },
  copilot: { command: 'copilot', args: ['--acp'] },
};
const selected = process.argv.slice(2).length
  ? process.argv.slice(2)
  : Object.keys(PROFILES);
const PROMPT = 'Reply with exactly the word PONG and nothing else.';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-smoke-'));
const daemonConfig = path.join(tmp, 'daemon-config');
fs.mkdirSync(path.join(daemonConfig, 'profiles'), { recursive: true });
for (const [name, p] of Object.entries(PROFILES))
  fs.writeFileSync(
    path.join(daemonConfig, 'profiles', `${name}.json`),
    JSON.stringify(p),
  );
const work = path.join(tmp, 'work');
fs.mkdirSync(work);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

function waitFor(proc, re, what) {
  let log = '';
  return new Promise((resolve, reject) => {
    const onData = (d) => {
      log += d;
      const m = log.match(re);
      if (m) resolve(m[1]);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) =>
      reject(new Error(`${what} exited early (${code}):\n${log}`)),
    );
    setTimeout(
      () => reject(new Error(`${what} did not start:\n${log}`)),
      20000,
    );
  });
}

const daemon = spawn(process.execPath, [DAEMON_MAIN], {
  env: {
    ...env,
    AGENT_DAEMON_LISTEN: '127.0.0.1:0',
    AGENT_DAEMON_CONFIG_DIR: daemonConfig,
    AGENT_DAEMON_STATE_DIR: path.join(tmp, 'daemon-state'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const daemonPort = await waitFor(
  daemon,
  /listening on ws:\/\/127\.0\.0\.1:(\d+)\//,
  'daemon',
);
const manager = spawn(process.execPath, [MANAGER_MAIN], {
  env: {
    ...env,
    AGENT_MANAGER_LISTEN: '127.0.0.1:0',
    AGENT_MANAGER_DAEMON_URL: `ws://127.0.0.1:${daemonPort}/`,
    AGENT_MANAGER_DATA_DIR: path.join(tmp, 'manager-data'),
    AGENT_MANAGER_ADMIN_PASSWORD: 'smoke',
    AGENT_MANAGER_UI_DIR: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const managerPort = await waitFor(
  manager,
  /listening on http:\/\/127\.0\.0\.1:(\d+)\//,
  'manager',
);
const base = `http://127.0.0.1:${managerPort}`;

let cookie = '';
async function api(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
await api('POST', '/api/auth/login', { name: 'admin', password: 'smoke' });
const project = (
  await api('POST', '/api/projects', { name: 'smoke', path: work })
).body.project;

const ws = new WebSocket(`ws://127.0.0.1:${managerPort}/api/events`, {
  headers: { cookie },
});
const frames = [];
ws.on('message', (m) => frames.push(JSON.parse(String(m))));
await new Promise((r) => ws.once('open', r));
const waitFrame = (test, ms = 150000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const f = frames.find(test);
      if (f) return resolve(f);
      if (Date.now() - t0 > ms) return reject(new Error('timed out'));
      setTimeout(tick, 100);
    };
    tick();
  });

let failed = 0;
for (const name of selected) {
  process.stdout.write(`${name}: `);
  try {
    const created = await api('POST', `/api/projects/${project.id}/agents`, {
      name,
      profile: name,
    });
    if (created.status !== 201)
      throw new Error(
        `create ${created.status} ${JSON.stringify(created.body)}`,
      );
    const id = created.body.agent.id;
    await waitFrame(
      (f) =>
        f.type === 'agent.state' &&
        f.agentId === id &&
        f.status.state === 'idle',
      60000,
    );
    const turn = await api('POST', `/api/agents/${id}/turn`, { text: PROMPT });
    if (turn.status !== 202)
      throw new Error(`turn ${turn.status} ${JSON.stringify(turn.body)}`);
    const end = await waitFrame(
      (f) =>
        f.type === 'agent.item' &&
        f.agentId === id &&
        f.item.item.kind === 'turn_end',
    );
    const items = (await api('GET', `/api/agents/${id}/items`)).body.items.map(
      (i) => i.item,
    );
    const texts = items
      .filter((i) => i.kind === 'text')
      .map((i) => i.text.trim());
    const errors = items
      .filter((i) => i.kind === 'error')
      .map((i) => i.message);
    const answer = texts[texts.length - 1] ?? '';
    const ok = answer === 'PONG' && errors.length === 0;
    if (!ok) failed++;
    const state = (await api('GET', `/api/agents/${id}`)).body.status.state;
    console.log(
      `${ok ? 'OK' : 'FAIL'} answer=${JSON.stringify(answer)} items=${items.length} state=${state}${errors.length ? ' errors=' + JSON.stringify(errors) : ''}`,
    );
    void end;
    await api('POST', `/api/agents/${id}/stop`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${err.message.split('\n')[0]}`);
  }
}
ws.close();
manager.kill('SIGTERM');
daemon.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 1500));
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
