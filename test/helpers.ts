import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp } from '../src/main.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FAKE_AGENT = path.join(ROOT, 'fixtures', 'fake-agent.mjs');
const DAEMON_MAIN =
  process.env.AGENT_DAEMON_MAIN ??
  path.resolve(ROOT, '..', 'agent-daemon', 'dist', 'main.js');

export const ADMIN_PASSWORD = 'test-password';

export interface TestDaemon {
  proc: ChildProcess;
  url: string;
  stateDir: string;
  stop(): Promise<void>;
}

/** A real agent-daemon on an ephemeral port with only the fake profile. */
export async function startDaemon(): Promise<TestDaemon> {
  if (!fs.existsSync(DAEMON_MAIN))
    throw new Error(
      `agent-daemon build not found at ${DAEMON_MAIN}; build it or set AGENT_DAEMON_MAIN`,
    );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-daemon-'));
  const configDir = path.join(root, 'config');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(path.join(configDir, 'profiles'), { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'profiles', 'fake.json'),
    JSON.stringify({ command: process.execPath, args: [FAKE_AGENT] }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_DAEMON_LISTEN: '127.0.0.1:0',
    AGENT_DAEMON_CONFIG_DIR: configDir,
    AGENT_DAEMON_STATE_DIR: stateDir,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const proc = spawn(process.execPath, [DAEMON_MAIN], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const port = await new Promise<number>((resolve, reject) => {
    const onData = (d: Buffer) => {
      log += d;
      const m = log.match(/listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) resolve(Number(m[1]));
    };
    proc.stdout!.on('data', onData);
    proc.stderr!.on('data', onData);
    proc.on('exit', (code) =>
      reject(new Error(`daemon exited early (${code}):\n${log}`)),
    );
    setTimeout(() => reject(new Error(`daemon did not start:\n${log}`)), 15000);
  });
  return {
    proc,
    url: `ws://127.0.0.1:${port}/`,
    stateDir,
    stop: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null) return resolve();
        proc.once('exit', () => resolve());
        proc.kill('SIGTERM');
        setTimeout(() => proc.kill('SIGKILL'), 5000).unref();
      }),
  };
}

export interface TestManager {
  app: NestExpressApplication;
  url: string;
  dataDir: string;
  stop(): Promise<void>;
}

export async function startManager(
  daemonUrl: string,
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-data-')),
): Promise<TestManager> {
  const app = await createApp(
    {
      host: '127.0.0.1',
      port: 0,
      daemonUrl,
      dataDir,
      adminPassword: ADMIN_PASSWORD,
      uiDir: null,
    },
    { quiet: !process.env.TEST_VERBOSE },
  );
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as { port: number };
  return {
    app,
    url: `http://127.0.0.1:${port}`,
    dataDir,
    stop: () => app.close(),
  };
}

/** Minimal HTTP client that keeps the login cookie. */
export class Api {
  cookie = '';
  constructor(readonly base: string) {}

  async call(
    method: string,
    p: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(this.base + p, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* not json */
    }
    return { status: res.status, body: parsed };
  }

  get = (p: string) => this.call('GET', p);
  post = (p: string, body?: unknown) => this.call('POST', p, body ?? {});
  patch = (p: string, body: unknown) => this.call('PATCH', p, body);
  delete = (p: string) => this.call('DELETE', p);

  async login(name = 'admin', password = ADMIN_PASSWORD) {
    return this.post('/api/auth/login', { name, password });
  }
}

/** Events websocket client with the same cookie. */
export class Events {
  readonly frames: any[] = [];
  private waiters: { test: (f: any) => boolean; resolve: (f: any) => void }[] =
    [];
  ws!: WebSocket;

  static connect(base: string, cookie: string): Promise<Events> {
    const e = new Events();
    e.ws = new WebSocket(base.replace(/^http/, 'ws') + '/api/events', {
      headers: cookie ? { cookie } : {},
    });
    return new Promise((resolve, reject) => {
      e.ws.on('message', (m) => {
        const f = JSON.parse(String(m));
        e.frames.push(f);
        const i = e.waiters.findIndex((w) => w.test(f));
        if (i >= 0) e.waiters.splice(i, 1)[0].resolve(f);
      });
      e.ws.once('open', () => resolve(e));
      e.ws.once('error', reject);
    });
  }

  waitFor(test: (f: any) => boolean, timeoutMs = 10000): Promise<any> {
    const found = this.frames.find(test);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () =>
          reject(
            new Error(
              `timed out; last frames: ${JSON.stringify(this.frames.slice(-4)).slice(0, 800)}`,
            ),
          ),
        timeoutMs,
      );
      this.waiters.push({
        test,
        resolve: (f) => {
          clearTimeout(t);
          resolve(f);
        },
      });
    });
  }

  clear(): void {
    this.frames.length = 0;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
