import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PushService } from '../src/push/push.service.js';
import { startDaemon, startManager, Api, Events } from './helpers.js';
import type { TestDaemon, TestManager } from './helpers.js';

/**
 * Web push: the key pair, a browser's subscription, and the rule that
 * sends. Nothing reaches a push service: the send is stubbed and what it
 * would have sent is inspected.
 */
let daemon: TestDaemon;
let m: TestManager;
let api: Api;
let events: Events;
let sent: { endpoint: string; payload: Record<string, unknown> }[] = [];

beforeAll(async () => {
  daemon = await startDaemon();
  m = await startManager(daemon.url);
  api = new Api(m.url);
  await api.login();
  events = await Events.connect(m.url, api.cookie);
  const push = m.app.get(PushService);
  push.send = async (sub, payload) => {
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    if (sub.endpoint.endsWith('/gone')) {
      const err = new Error('gone') as Error & { statusCode: number };
      err.statusCode = 410;
      throw err;
    }
  };
}, 30000);

afterAll(async () => {
  await events?.close();
  await m?.stop();
  await daemon?.stop();
});

const SUB = (endpoint: string) => ({
  endpoint,
  keys: { p256dh: 'BPublicKeyBytes', auth: 'authBytes' },
});

describe('push', () => {
  it('has a key pair of its own, kept in the data dir', async () => {
    const r = await api.get('/api/push/key');
    expect(r.status).toBe(200);
    expect(r.body.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(fs.existsSync(path.join(m.dataDir, 'push-keys.json'))).toBe(true);
    expect(
      fs.statSync(path.join(m.dataDir, 'push-keys.json')).mode & 0o077,
    ).toBe(0);
  });

  it('keeps a subscription per browser, sends a test to it, and drops one the service says is gone', async () => {
    expect(
      (
        await api.post('/api/push/subscriptions', {
          subscription: SUB('https://push.example/a'),
        })
      ).body,
    ).toEqual({ count: 1 });
    expect(
      (
        await api.post('/api/push/subscriptions', {
          subscription: SUB('https://push.example/gone'),
        })
      ).body,
    ).toEqual({ count: 2 });
    // the same endpoint again is the same subscription
    expect(
      (
        await api.post('/api/push/subscriptions', {
          subscription: SUB('https://push.example/a'),
        })
      ).body,
    ).toEqual({ count: 2 });
    expect(
      (
        await api.post('/api/push/subscriptions', {
          subscription: { endpoint: 'nope' },
        })
      ).status,
    ).toBe(400);
    sent = [];
    const t = await api.post('/api/push/test', {});
    expect(t.status).toBe(201);
    expect(t.body.sent).toBe(1); // the gone one failed and is dropped
    expect(sent.map((s) => s.endpoint).sort()).toEqual([
      'https://push.example/a',
      'https://push.example/gone',
    ]);
    expect(sent[0]!.payload).toMatchObject({
      title: 'agent-manager: this is a test',
      tag: 'test',
    });
    expect((await api.post('/api/push/test', {})).body.sent).toBe(1);
    expect(
      (
        await api.delete(
          `/api/push/subscriptions?endpoint=${encodeURIComponent('https://push.example/a')}`,
        )
      ).body,
    ).toEqual({ count: 0 });
  });

  it('an agent that needs input, or finished a turn a person sent, reaches the phone; a helper turn does not', async () => {
    await api.post('/api/push/subscriptions', {
      subscription: SUB('https://push.example/phone'),
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-push-'));
    const project = (
      await api.post('/api/projects', { name: 'pushed', path: dir })
    ).body.project;
    const { agent } = (
      await api.post(`/api/projects/${project.id}/agents`, {
        name: 'pinger',
        profile: 'fake',
        permissions: 'ask',
      })
    ).body;
    await events.waitFor(
      (f) =>
        f.type === 'agent.state' &&
        f.agentId === agent.id &&
        f.status.state === 'idle',
      10000,
    );
    sent = [];
    let mark = events.mark();
    await api.post(`/api/agents/${agent.id}/turn`, { text: 'hello' });
    await events.waitFor(
      (f) =>
        f.type === 'agent.item' &&
        f.agentId === agent.id &&
        f.item.item.kind === 'turn_end',
      10000,
      mark,
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(sent.map((s) => s.payload.title)).toEqual([
      'pinger is ready for more',
    ]);
    expect(sent[0]!.payload.url).toBe(
      `/projects/${project.id}/agents/${agent.id}`,
    );
    // a permission asked: needs your input
    sent = [];
    mark = events.mark();
    await api.post(`/api/agents/${agent.id}/turn`, {
      text: 'ask permission please',
    });
    await events.waitFor(
      (f) =>
        f.type === 'agent.state' &&
        f.agentId === agent.id &&
        f.status.state === 'waiting-permission',
      10000,
      mark,
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(sent.map((s) => s.payload.title)).toEqual([
      'pinger needs your input',
    ]);
    await api.delete(`/api/projects/${project.id}`);
  }, 30000);

  it('an agent token has no business here', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-push2-'));
    const project = (
      await api.post('/api/projects', { name: 'tok', path: dir })
    ).body.project;
    const { agent } = (
      await api.post(`/api/projects/${project.id}/agents`, {
        name: 'a',
        profile: 'fake',
      })
    ).body;
    const token = (
      m.app.get(
        (await import('../src/auth/auth.service.js')).AuthService,
      ) as any
    ).issueAgentToken(agent.id, project.id) as string;
    const r = await fetch(`${m.url}/api/push/key`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(403);
    await api.delete(`/api/projects/${project.id}`);
  });
});
