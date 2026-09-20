import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService } from '../src/db/db.service.js';
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
    JSON.stringify([
      { name: 'vibe', url: spoke.url, token: TOKEN },
      { name: 'wrong', url: spoke.url, token: 'not-the-token' }, // a misconfigured spoke: refused by the real one
    ]),
    { mode: 0o600 }, // anything wider is refused: the tokens are credentials
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
    expect(h.hosts.slice(0, 2)).toEqual([
      { name: 'main', local: true, connected: true, daemon: true },
      { name: 'vibe', local: false, connected: true, daemon: true },
    ]);
    expect(h.hosts[2]).toMatchObject({ name: 'wrong', connected: false }); // its socket was refused
    const hello = events.frames.find((f) => f.type === 'hello');
    expect(hello.hosts.map((x: any) => x.name)).toEqual([
      'main',
      'vibe',
      'wrong',
    ]);
    // a world-readable spokes file is ignored as a whole
    const loose = fs.mkdtempSync(path.join(os.tmpdir(), 'am-loose-'));
    fs.writeFileSync(
      path.join(loose, 'spokes.json'),
      JSON.stringify([{ name: 'x', url: spoke.url, token: TOKEN }]),
      { mode: 0o644 },
    );
    const looseHub = await startManager(hubDaemon.url, loose, {
      hostName: 'loose',
      spokesFile: path.join(loose, 'spokes.json'),
    });
    expect(
      (await new Api(looseHub.url).get('/api/health')).body.hosts.map(
        (x: any) => x.name,
      ),
    ).toEqual(['loose']);
    await looseHub.stop();
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
    // nothing but a plain id is forwarded: no leaving the project/agent routes on the spoke
    const traversal = await api.post(
      '/api/projects/vibe:../users/anyone/password',
      {},
    );
    expect(traversal.status).toBe(404);
    expect((await api.get('/api/projects/vibe:..%2Fusers')).status).toBe(404);
    // ...nor after a valid id, raw or encoded, since a URL parser would fold it
    const valid = created.body.project.id;
    for (const suffix of [
      '/../../users/x/password',
      '/agents/../../users',
      '/%2e%2e/users',
      '/agents/.%2e/x',
    ]) {
      const raw = await fetch(`${hub.url}/api/projects/${valid}${suffix}`, {
        method: 'POST',
        headers: { cookie: api.cookie, 'content-type': 'application/json' },
        body: '{}',
      });
      expect([404, 400]).toContain(raw.status);
    }
    // a spoke that refuses the hub's token: 502 with its own code, never a 401 the client would take for its own login
    const refused = await api.get('/api/projects/wrong:anything');
    expect(refused.status).toBe(502);
    expect(refused.body.code).toBe('spoke-auth');
    expect(
      (await api.get('/api/health')).body.hosts.find(
        (x: any) => x.name === 'wrong',
      ).error,
    ).toMatch(/refused/);
  });

  it('a hub user is created on the spoke by name on first sight, cannot get a password there, and the restart reply is prefixed', async () => {
    const bobPw = (await api.post('/api/users', { name: 'bob-hub' })).body
      .password;
    const bob = new Api(hub.url);
    await bob.login('bob-hub', bobPw);
    const pid = ((await bob.get('/api/projects')).body as any[]).find(
      (r) => r.project.host === 'vibe',
    ).project.id;
    expect((await bob.get(`/api/projects/${pid}`)).status).toBe(200);
    const onSpoke = (await spokeApi.get('/api/users')).body.users as any[];
    const created = onSpoke.find((u) => u.name === 'bob-hub');
    expect(created).toBeDefined();
    // the spoke's own admin cannot give that account a password: it logs in on the hub
    const reset = await spokeApi.post(`/api/users/${created.id}/password`, {});
    expect(reset.status).toBe(409);
    expect((await new Api(spoke.url).login('bob-hub', 'anything')).status).toBe(
      401,
    );
    // the restart reply names agents in the hub's id space
    const r = await api.post(`/api/projects/${pid}/agents/restart`, {});
    expect(r.status).toBe(201);
    for (const id of [
      ...r.body.restarted,
      ...r.body.skipped.map((s: any) => s.id),
    ])
      expect(id).toMatch(/^vibe:/);
    // presence about a spoke's agent is accepted on the hub (ids with the prefix)
    const agentId = (
      (await api.get(`/api/projects/${pid}/agents`)).body as any[]
    )[0]?.agent.id;
    if (agentId) {
      events.ws.send(
        JSON.stringify({ type: 'presence', agentId, typing: false }),
      );
      const p = await events.waitFor(
        (f) => f.type === 'presence' && f.agents[agentId],
        5000,
      );
      expect(p.agents[agentId].map((u: any) => u.name)).toContain('admin');
    }
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
    // an upload's raw body goes through the hub to the spoke as bytes
    const repo = (await api.get(`/api/projects/${pid}`)).body.project.repos[0]
      .name;
    const up = await fetch(
      `${hub.url}/api/projects/${pid}/file?path=${encodeURIComponent(`${repo}/from-hub.txt`)}`,
      {
        method: 'PUT',
        headers: {
          cookie: api.cookie,
          'content-type': 'application/octet-stream',
        },
        body: 'via the hub\n',
      },
    );
    expect(up.status).toBe(200);
    expect(fs.readFileSync(path.join(projectDir, 'from-hub.txt'), 'utf8')).toBe(
      'via the hub\n',
    );
    expect((await api.post(`/api/agents/${agentId}/stop`, {})).status).toBe(
      201,
    );
  }, 40000);

  it('reads a spoke\u2019s run log and reviews a run there, with the id prefixed once', async () => {
    // a run of the spoke's own project, put there directly: what is under
    // test is the forwarding and the id rewriting, not the opening, which
    // the run log's own suite covers
    const remote = (await spokeApi.get('/api/projects')).body[0].project;
    // the hub knows that project under a prefixed id, which is what a
    // client of the hub would filter by
    const prefixed = ((await api.get('/api/projects')).body as any[]).find(
      (r) => r.project.host === 'vibe',
    ).project.id;
    expect(prefixed).toBe(`vibe:${remote.id}`);
    const db = spoke.app.get(DbService).db;
    db.prepare(
      `INSERT INTO runs (id, project_id, project_name, host, repo, slug, agent_id, agent_name,
         profile, model, effort, permissions, started_at, ended_at, feature_status, outcome, item_from)
       VALUES ('run-1', ?, ?, 'vibe', 'repo', 'widget', 'agent-1', 'helper',
         'fake', 'fake-2', NULL, 'bypass', 1000, 2000, 'review', 'feature', 0)`,
    ).run(remote.id, remote.name);

    const listed = (await api.get(`/api/runs?project=${prefixed}`)).body.runs;
    expect(listed).toHaveLength(1);
    // prefixed once: the hub's own rewriting of a reply already does it,
    // and a run has the shape that rewriting takes for an agent
    expect(listed[0].id).toBe('vibe:run-1');
    expect(listed[0].projectId).toBe(prefixed);
    expect(listed[0].agentId).toBe('vibe:agent-1');
    expect(listed[0].slug).toBe('widget');

    const one = await api.get(`/api/runs/${listed[0].id}`);
    expect(one.status).toBe(200);
    expect(one.body.run.id).toBe('vibe:run-1');
    expect(one.body.transcript).toEqual([]);

    const reviewed = await api.put(`/api/runs/${listed[0].id}/review`, {
      outcome: 'sent-back',
      cause: 'doc',
      note: 'The spoke did not know the rule.',
    });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.run.id).toBe('vibe:run-1');
    expect(reviewed.body.run.review).toMatchObject({
      outcome: 'sent-back',
      cause: 'doc',
      by: 'admin',
    });
    // and it landed on the spoke, under its own id
    expect((await spokeApi.get('/api/runs/run-1')).body.run.review.cause).toBe(
      'doc',
    );
  }, 30000);

  it('reads and writes the operator files and the learnings of either machine', async () => {
    // the note-file routes forward by host; this is the first test of
    // that path, and it covers the harness and models files with it,
    // since all three are one implementation
    const hosts = (await api.get('/api/method')).body.hosts;
    expect(hosts.map((h: any) => h.host).sort()).toEqual(['main', 'vibe']);
    expect(hosts.every((h: any) => h.template.includes('The gate'))).toBe(true);
    const written = await api.put('/api/method', {
      host: 'vibe',
      template: '# How we work over there\n',
    });
    expect(written.status).toBe(200);
    expect(written.body).toMatchObject({ host: 'vibe', source: 'custom' });
    // it landed on the spoke, not here
    expect((await spokeApi.get('/api/method')).body.hosts[0].template).toBe(
      '# How we work over there\n',
    );
    expect(
      (await api.get('/api/method')).body.hosts.find(
        (h: any) => h.host === 'main',
      ).source,
    ).toBe('built-in');
    expect(
      (await api.put('/api/method', { host: 'nowhere', template: 'x' })).status,
    ).toBe(404);

    // the learnings log is per install: each machine keeps its own
    await api.post('/api/learnings', { text: 'Learned on the hub.' });
    const there = await api.post('/api/learnings', {
      host: 'vibe',
      text: 'Learned on the spoke.',
      ref: 'run x',
    });
    expect(there.status).toBe(201);
    expect(there.body).toMatchObject({ host: 'vibe' });
    expect(there.body.entry).toMatchObject({ n: 1, ref: 'run x' });
    const here = await api.get('/api/learnings');
    expect(here.body.host).toBe('main');
    expect(here.body.entries.map((e: any) => e.text)).toEqual([
      'Learned on the hub.',
    ]);
    const spokeLog = await api.get('/api/learnings?host=vibe');
    expect(spokeLog.body.host).toBe('vibe');
    expect(spokeLog.body.entries.map((e: any) => e.text)).toEqual([
      'Learned on the spoke.',
    ]);
    // and the spoke agrees about its own
    expect((await spokeApi.get('/api/learnings')).body.entries[0].text).toBe(
      'Learned on the spoke.',
    );
    expect((await api.get('/api/learnings?host=nowhere')).status).toBe(404);
  }, 30000);

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
    // the agents created earlier are gone with it from the hub's view; presence keys of that host are dropped
    expect(
      Object.keys(
        (
          await events
            .waitFor((f) => f.type === 'presence', 3000)
            .catch(() => ({ agents: {} }))
        ).agents,
      ).some((k) => k.startsWith('vibe:')),
    ).toBe(false);
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
