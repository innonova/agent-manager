import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Api,
  Events,
  TestDaemon,
  TestManager,
  sleep,
  startDaemon,
  startManager,
} from './helpers.js';

/**
 * A hub fronting for a spoke: two daemons, two managers. The spoke
 * accepts the hub's token; the hub lists the spoke's projects with
 * prefixed ids, proxies everything about them as the acting user, and
 * fans the spoke's events into its own stream.
 */
let spokeDaemon: TestDaemon;
let hubDaemon: TestDaemon;
let spoke: TestManager;
let hub: TestManager;
let api: Api; // on the hub
let events: Events;
let spokeApi: Api;
const TOKEN = 'hub-token-for-tests';
let projectDir: string;

beforeAll(async () => {
  spokeDaemon = await startDaemon();
  hubDaemon = await startDaemon();
  spoke = await startManager(spokeDaemon.url, undefined, {
    hubToken: TOKEN,
    hostName: 'vibe',
  });
  const hubData = fs.mkdtempSync(path.join(os.tmpdir(), 'am-hub-'));
  fs.writeFileSync(
    path.join(hubData, 'spokes.json'),
    JSON.stringify([{ name: 'vibe', url: spoke.url, token: TOKEN }]),
  );
  hub = await startManager(hubDaemon.url, hubData, {
    hostName: 'main',
    spokesFile: path.join(hubData, 'spokes.json'),
  });
  api = new Api(hub.url);
  await api.login();
  events = await Events.connect(hub.url, api.cookie);
  spokeApi = new Api(spoke.url);
  await spokeApi.login();
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-hub-proj-'));
  await sleep(500); // the hub's link to the spoke
}, 60000);

afterAll(async () => {
  await events?.close();
  await hub?.stop();
  await spoke?.stop();
  await hubDaemon?.stop();
  await spokeDaemon?.stop();
});

describe('hub', () => {
  it('lists both machines and the spoke in the hosts, and the token only with an acting user', async () => {
    const h = (await new Api(hub.url).get('/api/health')).body;
    expect(h.hosts).toEqual([
      { name: 'main', local: true, connected: true, daemon: true },
      { name: 'vibe', local: false, connected: true, daemon: true },
    ]);
    const hello = events.frames.find((f) => f.type === 'hello');
    expect(hello.hosts.map((x: any) => x.name)).toEqual(['main', 'vibe']);
    // the spoke: the token alone is not a login; with an acting user it is
    const bare = new Api(spoke.url);
    const r1 = await fetch(`${spoke.url}/api/projects`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r1.status).toBe(401);
    const r2 = await fetch(`${spoke.url}/api/projects`, {
      headers: { authorization: `Bearer wrong`, 'x-acting-user': 'alice' },
    });
    expect(r2.status).toBe(401);
    const r3 = await fetch(`${spoke.url}/api/auth/me`, {
      headers: { authorization: `Bearer ${TOKEN}`, 'x-acting-user': 'alice' },
    });
    expect(r3.status).toBe(200);
    expect(((await r3.json()) as any).user.name).toBe('alice');
    void bare;
  });

  it('creates a project on the spoke through the hub and sees it with a prefixed id and host', async () => {
    const created = await api.post('/api/projects', {
      name: 'remote',
      path: projectDir,
      defaultProfile: 'fake',
      host: 'vibe',
    });
    expect(created.body).toMatchObject({ project: { host: 'vibe' } });
    expect(created.status).toBe(201);
    expect(created.body.project.id).toMatch(/^vibe:/);
    const local = await api.post('/api/projects', {
      name: 'here',
      path: projectDir,
      defaultProfile: 'fake',
    });
    expect(local.body.project.host).toBe('main');
    const list = (await api.get('/api/projects')).body as any[];
    expect(
      list.map((r) => `${r.project.host}/${r.project.name}`).sort(),
    ).toEqual(['main/here', 'vibe/remote']);
    // the spoke knows it under its own id, created by the acting user
    const onSpoke = (await spokeApi.get('/api/projects')).body as any[];
    expect(onSpoke).toHaveLength(1);
    expect(`vibe:${onSpoke[0].project.id}`).toBe(created.body.project.id);
    expect(
      (await api.get(`/api/projects/${created.body.project.id}`)).body.project
        .name,
    ).toBe('remote');
    expect(
      (
        await api.get(`/api/projects/${created.body.project.id}/profiles`)
      ).body.profiles.map((p: any) => p.name),
    ).toContain('fake');
    expect((await api.get('/api/projects/vibe:nope')).status).toBe(404);
    expect((await api.get('/api/projects/nowhere:x')).status).toBe(404);
  });

  it('drives an agent on the spoke: turn, items and events through the hub, attributed to the hub user', async () => {
    const pid = ((await api.get('/api/projects')).body as any[]).find(
      (r) => r.project.host === 'vibe',
    ).project.id;
    const created = await api.post(`/api/projects/${pid}/agents`, {
      name: 'worker',
    });
    expect(created.status).toBe(201);
    const agentId = created.body.agent.id as string;
    expect(agentId).toMatch(/^vibe:/);
    expect(created.body.agent.projectId).toBe(pid);
    await events.waitFor(
      (f) =>
        f.type === 'agent.state' &&
        f.agentId === agentId &&
        f.status.state === 'idle',
      15000,
    );
    const mark = events.mark();
    const turned = await api.post(`/api/agents/${agentId}/turn`, {
      text: 'hello from the hub',
    });
    expect(turned.status).toBe(202);
    await events.waitFor(
      (f) =>
        f.type === 'agent.item' &&
        f.agentId === agentId &&
        f.item.item.kind === 'turn_end',
      15000,
      mark,
    );
    const items = (await api.get(`/api/agents/${agentId}/items`)).body
      .items as any[];
    const user = items.find((i) => i.item.kind === 'user');
    expect(user.item.text).toBe('hello from the hub');
    expect(user.item.by).toBe('admin'); // the hub user, created on the spoke
    expect(
      items.some(
        (i) => i.item.kind === 'text' && /hello from the hub/.test(i.item.text),
      ),
    ).toBe(true);
    const agents = (await api.get(`/api/projects/${pid}/agents`)).body as any[];
    expect(agents[0].agent.id).toBe(agentId);
    const counts = events.frames.filter(
      (f) => f.type === 'project.counts' && f.projectId === pid,
    );
    expect(counts.length).toBeGreaterThan(0);
    // features, files and changes go through too
    fs.mkdirSync(path.join(projectDir, 'features'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'features', 'thing.md'),
      '---\ntitle: a thing\nstatus: planned\npriority: 10\n---\n\nDo the thing.\n',
    );
    await sleep(3500);
    expect(
      (await api.get(`/api/projects/${pid}/features`)).body.features.map(
        (f: any) => f.slug,
      ),
    ).toContain('thing');
    expect((await api.get(`/api/projects/${pid}/files?path=`)).status).toBe(
      200,
    );
    expect((await api.post(`/api/agents/${agentId}/stop`, {})).status).toBe(
      201,
    );
  }, 40000);

  it('a spoke going away is reported, not fatal', async () => {
    const pid = ((await api.get('/api/projects')).body as any[]).find(
      (r) => r.project.host === 'vibe',
    ).project.id;
    const mark = events.mark();
    await spoke.stop();
    await events.waitFor(
      (f) =>
        f.type === 'hosts' &&
        f.hosts.some((h: any) => h.name === 'vibe' && !h.connected),
      10000,
      mark,
    );
    const list = (await api.get('/api/projects')).body as any[];
    expect(list.map((r) => r.project.host)).toEqual(['main']);
    const r = await api.get(`/api/projects/${pid}`);
    expect(r.status).toBe(502);
    expect(r.body.code).toBe('spoke-unreachable');
    expect(
      (await api.get('/api/health')).body.hosts.find(
        (h: any) => h.name === 'vibe',
      ).connected,
    ).toBe(false);
  }, 30000);
});
