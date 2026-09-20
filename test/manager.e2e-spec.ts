import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { DaemonClient } from '../src/daemon/daemon-client.js';
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

let daemon: TestDaemon;
let m: TestManager;
let api: Api;
let events: Events;
let projectDir: string;

beforeAll(async () => {
  daemon = await startDaemon();
  m = await startManager(daemon.url);
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-project-'));
  api = new Api(m.url);
  await api.login();
  events = await Events.connect(m.url, api.cookie);
}, 30000);

afterAll(async () => {
  await events?.close();
  await m?.stop();
  await daemon?.stop();
});

async function createProject(name = 'p') {
  const r = await api.post('/api/projects', {
    name,
    path: projectDir,
    defaultProfile: 'fake',
  });
  expect(r.status).toBe(201);
  return r.body.project as { id: string; path: string };
}

async function createAgent(projectId: string, name = 'a') {
  const r = await api.post(`/api/projects/${projectId}/agents`, { name });
  expect(r.status).toBe(201);
  return r.body as {
    agent: { id: string; currentSessionId: string };
    status: { state: string };
  };
}

const itemsOf = (agentId: string) =>
  events.frames
    .filter((f) => f.type === 'agent.item' && f.agentId === agentId)
    .map((f) => f.item);

describe('health', () => {
  it('is public and reports the daemon link', async () => {
    const r = await new Api(m.url).get('/api/health');
    expect(r).toMatchObject({
      status: 200,
      body: { status: 'ok', daemon: true },
    });
  });
});

describe('auth', () => {
  it('rejects anonymous requests and bad logins, accepts the admin', async () => {
    const anon = new Api(m.url);
    expect((await anon.get('/api/projects')).status).toBe(401);
    expect((await anon.login('admin', 'wrong')).status).toBe(401);
    expect((await anon.login('nobody', 'x')).status).toBe(401);
    const ok = await anon.login();
    expect(ok.status).toBe(201);
    expect(ok.body.user.name).toBe('admin');
    expect(anon.cookie).toMatch(/^am_session=/);
    expect((await anon.get('/api/auth/me')).body.user.name).toBe('admin');
    const cookie = anon.cookie;
    const sock = await Events.connect(m.url, cookie);
    const closed = new Promise<number>((resolve) =>
      sock.ws.once('close', (code) => resolve(code)),
    );
    expect((await anon.post('/api/auth/logout')).status).toBe(201);
    expect(await closed).toBe(4401); // the socket of that login session is closed
    anon.cookie = cookie; // the old token itself is dead, not just the browser's copy
    expect((await anon.get('/api/auth/me')).status).toBe(401);
  });

  it('throttles repeated login attempts', async () => {
    const strict = await startManager(daemon.url, undefined, {
      loginAttemptsPerMinute: 3,
    });
    try {
      const anon = new Api(strict.url);
      const codes: number[] = [];
      for (let i = 0; i < 5; i++)
        codes.push((await anon.login('admin', 'wrong')).status);
      expect(codes).toEqual([401, 401, 401, 429, 429]);
    } finally {
      await strict.stop();
    }
  });

  it('refuses cross-origin mutations and sockets, accepts same-origin', async () => {
    const res = await fetch(`${m.url}/api/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://evil.example',
      },
      body: JSON.stringify({ name: 'admin', password: 'x' }),
    });
    expect(res.status).toBe(403);
    const same = await fetch(`${m.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: m.url },
      body: JSON.stringify({ name: 'admin', password: 'x' }),
    });
    expect(same.status).toBe(401);
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(m.url.replace('http', 'ws') + '/api/events', {
        headers: { cookie: api.cookie, origin: 'http://evil.example' },
      });
      ws.once('close', (c) => resolve(c));
      ws.once('error', () => resolve(-1));
    });
    expect(code).toBe(4403);
  });

  it('rejects non-object bodies and bad cursors without crashing', async () => {
    const raw = await fetch(`${m.url}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: api.cookie },
      body: '[1]',
    });
    expect(raw.status).toBe(400);
    const none = await fetch(`${m.url}/api/projects`, {
      method: 'POST',
      headers: { cookie: api.cookie },
    });
    expect(none.status).toBe(400);
    expect((await api.get('/api/agents/x/items?from=wat')).status).toBe(400);
    expect((await api.get('/api/agents/x/items?from=-1')).status).toBe(400);
  });

  it('closes an unauthenticated events socket with 4401', async () => {
    const closed = await new Promise<number>((resolve) => {
      Events.connect(m.url, '')
        .then((e) => e.ws.once('close', (code) => resolve(code)))
        .catch(() => resolve(-1));
    });
    expect(closed).toBe(4401);
    expect(events.frames[0]).toMatchObject({
      type: 'hello',
      user: 'admin',
      daemon: { connected: true },
    });
  });
});

describe('ui build announcements', () => {
  it('hello carries the served build id and a swapped build is announced on the ping tick', async () => {
    const uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-ui-'));
    fs.writeFileSync(path.join(uiDir, 'index.html'), '<html></html>');
    fs.writeFileSync(
      path.join(uiDir, 'build.json'),
      JSON.stringify({ id: 'one' }),
    );
    const m2 = await startManager(daemon.url, undefined, {
      uiDir,
      eventsPingMs: 150,
    });
    try {
      const api2 = new Api(m2.url);
      await api2.login();
      const e = await Events.connect(m2.url, api2.cookie);
      expect(e.frames[0]).toMatchObject({ type: 'hello', uiBuild: 'one' });
      const mark = e.mark();
      fs.writeFileSync(
        path.join(uiDir, 'build.json'),
        JSON.stringify({ id: 'two' }),
      );
      const f = await e.waitFor((x) => x.type === 'ui.build', 5000, mark);
      expect(f.id).toBe('two');
      await e.close();
    } finally {
      await m2.stop();
    }
  });
});

describe('events keepalive', () => {
  it('pings clients so idle sockets survive proxies', async () => {
    const m2 = await startManager(daemon.url, undefined, { eventsPingMs: 150 });
    try {
      const api2 = new Api(m2.url);
      await api2.login();
      const e = await Events.connect(m2.url, api2.cookie);
      const pinged = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 2000);
        e.ws.once('ping', () => {
          clearTimeout(t);
          resolve(true);
        });
      });
      expect(pinged).toBe(true);
      await sleep(400); // several ping rounds; the ws client answers them
      expect(e.ws.readyState).toBe(WebSocket.OPEN);
      await e.close();
    } finally {
      await m2.stop();
    }
  });
});

describe('projects', () => {
  it('creates, lists with counts, updates and deletes', async () => {
    const p = await createProject('proj');
    const list = await api.get('/api/projects');
    expect(list.body.find((x: any) => x.project.id === p.id)).toMatchObject({
      project: { name: 'proj', path: projectDir },
      agentCounts: { idle: 0, working: 0 },
    });
    expect(
      (await api.patch(`/api/projects/${p.id}`, { name: 'renamed' })).body
        .project.name,
    ).toBe('renamed');
    expect(
      (await api.post('/api/projects', { name: 'x', path: 'nope' })).status,
    ).toBe(400);
    expect((await api.delete(`/api/projects/${p.id}`)).status).toBe(200);
    expect((await api.get(`/api/projects/${p.id}`)).status).toBe(404);
  });

  it('restarting a project resumes idle agents and skips busy ones', async () => {
    const p = await createProject();
    const { agent: idle } = await createAgent(p.id, 'idle-one');
    const { agent: busy } = await createAgent(p.id, 'busy-one');
    // the startup idle may still be on its way: wait for the turn itself
    let mark = events.mark();
    await api.post(`/api/agents/${idle.id}/turn`, { text: 'hello' });
    await events.waitFor(
      (f) =>
        f.type === 'agent.item' &&
        f.agentId === idle.id &&
        f.item.item.kind === 'turn_end',
      10000,
      mark,
    );
    for (let i = 0; i < 100; i++) {
      if (
        (await api.get(`/api/agents/${idle.id}`)).body.status.state === 'idle'
      )
        break;
      await sleep(20);
    }
    const first = (await api.get(`/api/agents/${idle.id}`)).body.agent;
    mark = events.mark();
    await api.post(`/api/agents/${busy.id}/turn`, { text: 'slow please' });
    await events.waitFor(
      (f) =>
        f.type === 'agent.state' &&
        f.agentId === busy.id &&
        f.status.state === 'working',
      10000,
      mark,
    );
    const r = await api.post(`/api/projects/${p.id}/agents/restart`, {});
    expect(r.status).toBe(201);
    expect(r.body).toEqual({
      restarted: [idle.id],
      skipped: [{ id: busy.id, why: 'working' }],
    });
    const after = await api.get(`/api/agents/${idle.id}`);
    expect(after.body.agent.currentSessionId).not.toBe(first.currentSessionId);
    expect(after.body.agent.vendorConversationId).toBe(
      first.vendorConversationId,
    ); // resumed
    expect(after.body.sessions).toHaveLength(2);
    await events.waitFor(
      (f) =>
        f.type === 'agent.state' &&
        f.agentId === idle.id &&
        f.status.state === 'idle',
      10000,
      mark,
    );
    const kinds = (
      await api.get(`/api/agents/${idle.id}/items`)
    ).body.items.map((i: any) => i.item.kind);
    expect(kinds.slice(-2)).toEqual(['system', 'system']); // session ended, session resumed
    await api.post(`/api/agents/${busy.id}/interrupt`).catch(() => undefined);
  }, 30000);

  it('deleting a project stops its agents and forgets them', async () => {
    const p = await createProject('doomed');
    const { agent } = await createAgent(p.id);
    expect((await api.delete(`/api/projects/${p.id}`)).status).toBe(200);
    expect((await api.get(`/api/agents/${agent.id}`)).status).toBe(404);
    const rec = await new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(daemon.url);
      ws.on('open', () =>
        ws.send(
          JSON.stringify({
            type: 'session.get',
            ref: 1,
            id: agent.currentSessionId,
          }),
        ),
      );
      ws.on('message', (d) => (ws.close(), resolve(JSON.parse(String(d)))));
      ws.on('error', reject);
    });
    expect(rec.session.state).toBe('exited');
  });

  it('lists daemon profiles with adapter support', async () => {
    const r = await api.get('/api/profiles');
    expect(r.body.profiles).toEqual([
      expect.objectContaining({ name: 'fake', supported: true }),
    ]);
  });
});

describe('agents', () => {
  it('uploads a file into a repository and creates directories; refuses to leave it or to clobber silently', async () => {
    const p = await createProject();
    const put = (path: string, body: string | Buffer, overwrite = false) =>
      fetch(
        `${m.url}/api/projects/${p.id}/file?path=${encodeURIComponent(path)}${overwrite ? '&overwrite=1' : ''}`,
        {
          method: 'PUT',
          headers: {
            cookie: api.cookie,
            'content-type': 'application/octet-stream',
          },
          body: typeof body === 'string' ? body : new Uint8Array(body),
        },
      );
    const repo = (await api.get(`/api/projects/${p.id}`)).body.project.repos[0]
      .name;
    let r = await put(`${repo}/notes/app.log`, 'line one\n');
    expect(r.status).toBe(404); // the directory is not there yet
    const mk = await api.post(`/api/projects/${p.id}/dir`, {
      path: `${repo}/notes/2026`,
    });
    expect(mk.status).toBe(201);
    expect(mk.body).toEqual({ path: `${repo}/notes/2026`, created: true });
    expect(
      (
        await api.post(`/api/projects/${p.id}/dir`, {
          path: `${repo}/notes/2026`,
        })
      ).body.created,
    ).toBe(false);
    r = await put(`${repo}/notes/app.log`, 'line one\n');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      path: `${repo}/notes/app.log`,
      size: 9,
      replaced: false,
    });
    expect(fs.readFileSync(path.join(p.path, 'notes', 'app.log'), 'utf8')).toBe(
      'line one\n',
    );
    r = await put(`${repo}/notes/app.log`, 'line two\n');
    expect(r.status).toBe(409);
    r = await put(`${repo}/notes/app.log`, 'line two\n', true);
    expect((await r.json()).replaced).toBe(true);
    const bin = Buffer.from([0, 1, 2, 255]);
    r = await put(`${repo}/notes/2026/blob.bin`, bin);
    expect(r.status).toBe(200);
    expect(
      fs.readFileSync(path.join(p.path, 'notes', '2026', 'blob.bin')),
    ).toEqual(bin);
    // seen by the tree, and readable back
    const top = (await api.get(`/api/projects/${p.id}/files?path=${repo}`)).body
      .entries;
    expect(top.find((e: any) => e.name === 'notes')).toMatchObject({
      type: 'dir',
    }); // (the test project is not a git repository)
    const listed = (
      await api.get(`/api/projects/${p.id}/files?path=${repo}/notes`)
    ).body.entries;
    expect(listed.find((e: any) => e.name === 'app.log')).toMatchObject({
      type: 'file',
    });
    expect(
      (await api.get(`/api/projects/${p.id}/file?path=${repo}/notes/app.log`))
        .body.content,
    ).toBe('line two\n');
    // never outside a repository
    expect((await put(`${repo}/../outside.txt`, 'x')).status).toBe(400);
    expect((await put(`nope/x.txt`, 'x')).status).toBe(404);
    expect((await put(`${repo}`, 'x')).status).toBe(400);
    expect(
      (await api.post(`/api/projects/${p.id}/dir`, { path: `${repo}/../up` }))
        .status,
    ).toBe(400);
    expect(
      (
        await api.post(`/api/projects/${p.id}/dir`, {
          path: `${repo}/notes/app.log`,
        })
      ).status,
    ).toBe(409);
    expect(
      (await put(`${repo}/big.bin`, Buffer.alloc(26 * 1024 * 1024))).status,
    ).toBe(413);
    // a replacement keeps the file's mode; a file in the way of a directory is a 409; a long name is fine
    fs.chmodSync(path.join(p.path, 'notes', 'app.log'), 0o755);
    expect(
      (await put(`${repo}/notes/app.log`, '#!/bin/sh\n', true)).status,
    ).toBe(200);
    expect(
      fs.statSync(path.join(p.path, 'notes', 'app.log')).mode & 0o777,
    ).toBe(0o755);
    expect(
      (
        await api.post(`/api/projects/${p.id}/dir`, {
          path: `${repo}/notes/app.log/child`,
        })
      ).status,
    ).toBe(409);
    expect(
      (await put(`${repo}/notes/${'n'.repeat(250)}.txt`, 'x')).status,
    ).toBe(200);
    expect(
      fs
        .readdirSync(path.join(p.path, 'notes'))
        .filter((n) => n.startsWith('.upload-')),
    ).toEqual([]);
  }, 30000);

  it('an agent reporting its account usage shows it on its status and in the usage listing', async () => {
    const p = await createProject();
    const { agent } = await createAgent(p.id, 'quota');
    const mark = events.mark();
    await api.post(`/api/agents/${agent.id}/turn`, { text: 'usage 85' });
    const st = await events.waitFor(
      (f) =>
        f.type === 'agent.state' && f.agentId === agent.id && f.status.usage,
      10000,
      mark,
    );
    expect(st.status.usage).toMatchObject({
      windows: [
        { name: '5h', usedPercent: 85 },
        { name: '7d', usedPercent: 43 },
      ],
      status: 'warning',
    });
    const u = (await api.get('/api/usage')).body;
    const fake = u.hosts
      .flatMap((h: any) => h.accounts)
      .find((a: any) => a.profile === 'fake');
    expect(fake).toMatchObject({
      agentId: agent.id,
      usage: { status: 'warning' },
    });
  }, 30000);

  it('an agent is told about the harness at session start, from the operator template when there is one', async () => {
    const p = await createProject();
    const { agent } = await createAgent(p.id, 'told');
    let mark = events.mark();
    await api.post(`/api/agents/${agent.id}/turn`, {
      text: 'what is your note?',
    });
    await events.waitFor(
      (f) =>
        f.type === 'agent.item' &&
        f.agentId === agent.id &&
        f.item.item.kind === 'turn_end',
      10000,
      mark,
    );
    const said = itemsOf(agent.id)
      .filter((i) => i.item.kind === 'text')
      .map((i) => (i.item as { text: string }).text)
      .join('\n');
    expect(said).toContain('Running under agent-manager'); // the built-in note, filled in
    expect(said).toContain('features/<slug>.md');
    const got = (await api.get(`/api/agents/${agent.id}`)).body.agent;
    expect(got.harnessNote).toContain('There is no terminal.'); // what it was told, on the record
    // an operator template replaces the note; an empty one turns it off
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'am-harness-')),
      'harness.md',
    );
    fs.writeFileSync(file, 'Custom note for {{agent}} in {{project}}.');
    const m2 = await startManager(daemon.url, undefined, { harnessFile: file });
    try {
      const api2 = new Api(m2.url);
      await api2.login();
      const p2 = (
        await api2.post('/api/projects', {
          name: 'custom',
          path: projectDir,
          defaultProfile: 'fake',
        })
      ).body.project;
      const a2 = (
        await api2.post(`/api/projects/${p2.id}/agents`, {
          name: 'custom-told',
        })
      ).body.agent;
      expect(a2.harnessNote).toBe('Custom note for custom-told in custom.');
      fs.writeFileSync(file, '');
      const a3 = (
        await api2.post(`/api/projects/${p2.id}/agents`, { name: 'untold' })
      ).body.agent;
      expect(a3.harnessNote).toBeNull();
    } finally {
      await m2.stop();
    }
  }, 30000);

  it('the harness template is read and written per host through the API', async () => {
    const before = (await api.get('/api/harness')).body.hosts;
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ source: 'built-in' });
    expect(before[0].template).toBe(before[0].builtIn);
    const custom = await api.put('/api/harness', {
      template: 'Custom note for {{agent}}.',
    });
    expect(custom.status).toBe(200);
    expect(custom.body).toMatchObject({
      source: 'custom',
      template: 'Custom note for {{agent}}.',
    });
    expect(fs.readFileSync(custom.body.file, 'utf8')).toBe(
      'Custom note for {{agent}}.',
    );
    const p = await createProject();
    const { agent } = await createAgent(p.id, 'noted');
    expect(agent).toMatchObject({ harnessNote: 'Custom note for noted.' });
    expect((await api.put('/api/harness', { template: '' })).body.source).toBe(
      'off',
    );
    expect(
      (await api.put('/api/harness', { template: null })).body.source,
    ).toBe('built-in');
    expect(fs.existsSync(custom.body.file)).toBe(false);
    expect((await api.put('/api/harness', { template: 42 })).status).toBe(400);
    expect(
      (await api.put('/api/harness', { host: 'nowhere', template: 'x' }))
        .status,
    ).toBe(404);
  });

  it('a restart starts the vendor spend over; the status carries the total across the sessions', async () => {
    const p = await createProject();
    const { agent } = await createAgent(p.id, 'spender');
    let mark = events.mark();
    await api.post(`/api/agents/${agent.id}/turn`, { text: 'usage 10' });
    const first = await events.waitFor(
      (f) =>
        f.type === 'agent.state' && f.agentId === agent.id && f.status.usage,
      10000,
      mark,
    );
    expect(first.status.usage.spend).toMatchObject({ turns: 1, costUsd: 0.1 });
    expect(first.status.usage.total).toBeUndefined(); // one session: nothing to add
    for (let i = 0; i < 100; i++) {
      if (
        (await api.get(`/api/agents/${agent.id}`)).body.status.state === 'idle'
      )
        break;
      await sleep(20);
    }
    const r = await api.post(`/api/projects/${p.id}/agents/restart`, {});
    expect(r.body.restarted).toEqual([agent.id]);
    mark = events.mark();
    await api.post(`/api/agents/${agent.id}/turn`, { text: 'usage 20' });
    const second = await events.waitFor(
      (f) =>
        f.type === 'agent.state' &&
        f.agentId === agent.id &&
        f.status.usage?.spend?.costUsd === 0.2,
      10000,
      mark,
    );
    expect(second.status.usage.spend).toMatchObject({ turns: 1, costUsd: 0.2 });
    expect(second.status.usage.total).toMatchObject({
      inputTokens: 30000,
      outputTokens: 300,
      turns: 2,
    });
    expect(second.status.usage.total.costUsd).toBeCloseTo(0.3);
  }, 30000);

  it('a turn may carry images, within limits; they show on the user item and reach the agent', async () => {
    const p = await createProject();
    const { agent } = await createAgent(p.id, 'looker');
    const png = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };
    const mark = events.mark();
    const r = await api.post(`/api/agents/${agent.id}/turn`, {
      text: 'look',
      images: [png, png],
    });
    expect(r.status).toBe(202);
    await events.waitFor(
      (f) =>
        f.type === 'agent.item' &&
        f.agentId === agent.id &&
        f.item.item.kind === 'turn_end',
      15000,
      mark,
    );
    const items = (await api.get(`/api/agents/${agent.id}/items`)).body
      .items as any[];
    const user = items.find((i) => i.item.kind === 'user');
    expect(user.item.images).toEqual([png, png]);
    expect(
      items.some(
        (i) => i.item.kind === 'text' && /with 2 images/.test(i.item.text),
      ),
    ).toBe(true);
    // limits and shapes
    const bad = async (images: unknown) =>
      (await api.post(`/api/agents/${agent.id}/turn`, { text: 'x', images }))
        .status;
    expect(await bad('nope')).toBe(400);
    expect(await bad([{ mediaType: 'text/plain', data: 'aGk=' }])).toBe(400);
    expect(await bad([{ mediaType: 'image/png', data: 'not base64!' }])).toBe(
      400,
    );
    expect(await bad([{ mediaType: 'image/png', data: 'A' }])).toBe(400); // not a whole group
    expect(await bad([{ mediaType: 'image/png', data: 'AAAA=====' }])).toBe(
      400,
    ); // padding in the wrong place
    expect(await bad([{ mediaType: 'image/png', data: '' }])).toBe(400);
    expect(await bad(Array(5).fill(png))).toBe(400);
    expect(
      await bad([
        {
          mediaType: 'image/png',
          data: 'A'.repeat((4 * 1024 * 1024 * 4) / 3 + 4),
        },
      ]),
    ).toBe(400);
  }, 30000);

  it('a message during a turn is refused without steer and taken mid-turn with it', async () => {
    const p = await createProject();
    const { agent } = await createAgent(p.id, 'steered');
    const mark = events.mark();
    await api.post(`/api/agents/${agent.id}/turn`, { text: 'slow please' });
    await events.waitFor(
      (f) =>
        f.type === 'agent.state' &&
        f.agentId === agent.id &&
        f.status.state === 'working',
      10000,
      mark,
    );
    const plain = await api.post(`/api/agents/${agent.id}/turn`, {
      text: 'and this',
    });
    expect(plain.status).toBe(409);
    expect(plain.body.code).toBe('agent-busy');
    const steered = await api.post(`/api/agents/${agent.id}/turn`, {
      text: 'and this',
      steer: true,
    });
    expect(steered.status).toBe(202);
    expect(steered.body.mode).toBe('steered');
    await events.waitFor(
      (f) =>
        f.type === 'agent.item' &&
        f.agentId === agent.id &&
        f.item.item.kind === 'turn_end',
      15000,
      mark,
    );
    const items = (await api.get(`/api/agents/${agent.id}/items`)).body
      .items as any[];
    const kinds = items.map((i) => i.item.kind);
    // one turn: user, text (streamed), the steering message, the noted text, one turn end
    expect(kinds.filter((k) => k === 'turn_end')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'user')).toHaveLength(2);
    expect(
      items.find((i) => i.item.kind === 'user' && i.item.text === 'and this')
        .item.by,
    ).toBe('admin');
    const texts = items
      .filter((i) => i.item.kind === 'text')
      .map((i) => i.item.text);
    expect(texts.some((t) => /Also noted: and this/.test(t))).toBe(true);
    expect(kinds.indexOf('user')).toBeLessThan(kinds.lastIndexOf('user'));
    expect(kinds.lastIndexOf('user')).toBeLessThan(
      kinds.lastIndexOf('turn_end'),
    );
  }, 30000);

  it('creates an agent with a live session and streams a turn as items', async () => {
    const p = await createProject();
    events.clear();
    const { agent, status } = await createAgent(p.id, 'worker');
    expect(['starting', 'idle']).toContain(status.state); // idle once the fake agent has said init
    expect(agent.currentSessionId).toBeTruthy();
    await events.waitFor(
      (f) =>
        f.type === 'agent.state' &&
        f.agentId === agent.id &&
        f.status.state === 'idle',
    );
    expect((await api.get(`/api/projects/${p.id}`)).body.agentCounts.idle).toBe(
      1,
    );

    const turn = await api.post(`/api/agents/${agent.id}/turn`, {
      text: 'hello there',
    });
    expect(turn.status).toBe(202);
    await events.waitFor(
      (f) =>
        f.type === 'agent.state' &&
        f.agentId === agent.id &&
        f.status.state === 'working',
    );
    await events.waitFor(
      (f) =>
        f.type === 'agent.item' &&
        f.agentId === agent.id &&
        f.item.item.kind === 'turn_end',
    );
    await events.waitFor(
      (f) =>
        f.type === 'agent.state' &&
        f.agentId === agent.id &&
        f.status.state === 'idle',
    );

    const stored = (await api.get(`/api/agents/${agent.id}/items`)).body
      .items as any[];
    expect(stored.map((i) => i.item.kind)).toEqual([
      'system',
      'user',
      'text',
      'turn_end',
    ]);
    expect(stored[1].item.text).toBe('hello there');
    expect(stored[2].item).toMatchObject({
      streaming: false,
      text: expect.stringContaining('You said: hello there'),
    });
    // the same text item was pushed repeatedly while streaming, at one index
    const streamed = itemsOf(agent.id).filter((i) => i.item.kind === 'text');
    expect(streamed.length).toBeGreaterThan(2);
    expect(new Set(streamed.map((i) => i.index)).size).toBe(1);
    expect(
      (await api.get(`/api/agents/${agent.id}/items?from=2`)).body.items.map(
        (i: any) => i.index,
      ),
    ).toEqual([2, 3]);
    const counts = await events.waitFor(
      (f) =>
        f.type === 'project.counts' &&
        f.projectId === p.id &&
        f.counts.idle === 1 &&
        f.counts.working === 0,
    );
    expect(counts).toBeTruthy();
  });

  it('renders tool calls, errors and interrupts', async () => {
    const p = await createProject();
    const { agent } = await createAgent(p.id);
    await api.post(`/api/agents/${agent.id}/turn`, {
      text: 'please use a tool',
    });
    await events.waitFor(
      (f) =>
        f.type === 'agent.item' &&
        f.agentId === agent.id &&
        f.item.item.kind === 'turn_end',
    );
    let kinds = (await api.get(`/api/agents/${agent.id}/items`)).body.items.map(
      (i: any) => i.item.kind,
    );
    expect(kinds).toEqual([
      'system',
      'user',
      'thinking',
      'tool_use',
      'tool_result',
      'text',
      'turn_end',
    ]);

    await api.post(`/api/agents/${agent.id}/turn`, { text: 'now error out' });
    const err = await events.waitFor(
      (f) =>
        f.type === 'agent.state' &&
        f.agentId === agent.id &&
        f.status.state === 'error',
    );
    expect(err.status.error).toContain('usage limit');
    expect(
      (await api.get(`/api/agents/${agent.id}`)).body.status,
    ).toMatchObject({
      state: 'error',
      error: expect.stringContaining('usage limit'),
    });
    expect(
      (await api.get(`/api/projects/${p.id}`)).body.agentCounts.error,
    ).toBe(1);

    // a new turn clears the error state; interrupting it cuts the answer short
    const mark = events.mark();
    await api.post(`/api/agents/${agent.id}/turn`, { text: 'slow please' });
    await events.waitFor(
      (f) =>
        f.type === 'agent.state' &&
        f.agentId === agent.id &&
        f.status.state === 'working',
      10000,
      mark,
    );
    // a second turn while working is refused
    expect(
      await api.post(`/api/agents/${agent.id}/turn`, { text: 'queued?' }),
    ).toMatchObject({ status: 409, body: { code: 'agent-busy' } });
    await sleep(200);
    expect((await api.post(`/api/agents/${agent.id}/interrupt`)).status).toBe(
      201,
    );
    await events.waitFor(
      (f) =>
        f.type === 'agent.state' &&
        f.agentId === agent.id &&
        f.status.state === 'idle',
      15000,
      mark,
    );
    const all = (await api.get(`/api/agents/${agent.id}/items`)).body
      .items as any[];
    kinds = all.map((i) => i.item.kind);
    expect(kinds.filter((k: string) => k === 'error')).toHaveLength(1);
    const cut = [...all].reverse().find((i) => i.item.kind === 'text')!.item;
    expect(cut.kind).toBe('text');
    expect(cut.streaming).toBe(false);
    expect(cut.text.length).toBeLessThan(
      'This is a deliberately slow answer that streams word by word so the user interface can be seen updating. '.repeat(
        3,
      ).length,
    );
    expect(
      all.some(
        (i) =>
          i.item.kind === 'system' && i.item.text === 'interrupt requested',
      ),
    ).toBe(true);
  });

  it('survives a session exit and resumes on the next turn', async () => {
    const p = await createProject();
    const { agent } = await createAgent(p.id);
    const first = agent.currentSessionId;
    await api.post(`/api/agents/${agent.id}/turn`, { text: 'remember me' });
    await events.waitFor(
      (f) =>
        f.type === 'agent.item' &&
        f.agentId === agent.id &&
        f.item.item.kind === 'turn_end',
    );
    await api.post(`/api/agents/${agent.id}/turn`, { text: 'please exit' });
    await events.waitFor(
      (f) =>
        f.type === 'agent.state' &&
        f.agentId === agent.id &&
        f.status.state === 'exited',
    );
    let got = await api.get(`/api/agents/${agent.id}`);
    expect(got.body.agent.currentSessionId).toBeNull();
    expect(got.body.sessions).toHaveLength(1);
    expect(got.body.sessions[0].endedAt).toBeTruthy();

    const resumeMark = events.mark();
    expect(
      (await api.post(`/api/agents/${agent.id}/turn`, { text: 'back again' }))
        .status,
    ).toBe(202);
    // the resumed session is working, not idle, even though its init line arrives after our input
    expect(
      (await api.post(`/api/agents/${agent.id}/turn`, { text: 'too soon' }))
        .status,
    ).toBe(409);
    await events.waitFor(
      (f) =>
        f.type === 'agent.item' &&
        f.agentId === agent.id &&
        f.item.item.kind === 'turn_end' &&
        f.item.sessionId !== first,
      10000,
      resumeMark,
    );
    got = await api.get(`/api/agents/${agent.id}`);
    expect(got.body.agent.currentSessionId).not.toBe(first);
    expect(got.body.sessions).toHaveLength(2);
    expect(got.body.status.state).toBe('idle');
    const items = (await api.get(`/api/agents/${agent.id}/items`)).body
      .items as any[];
    const system = items
      .filter((i) => i.item.kind === 'system')
      .map((i) => i.item.text);
    expect(system.some((t: string) => t.startsWith('session started'))).toBe(
      true,
    );
    expect(system.some((t: string) => t.startsWith('session ended'))).toBe(
      true,
    );
    expect(system.some((t: string) => t.startsWith('session resumed'))).toBe(
      true,
    );
    // the fake agent was resumed with the same conversation id
    const init = fs
      .readFileSync(
        path.join(
          daemon.stateDir,
          'sessions',
          got.body.agent.currentSessionId,
          'log.ndjson',
        ),
        'utf8',
      )
      .split('\n')
      .map((l) => (l ? JSON.parse(l) : null))
      .find((r) => r && r.s === 'out' && r.d.includes('"init"'));
    expect(JSON.parse(init.d)).toMatchObject({
      resumed: true,
      conversationId: got.body.agent.vendorConversationId,
    });
  });

  it('restarts one agent with its conversation, and refuses while it works', async () => {
    const p = await createProject();
    const { agent } = await createAgent(p.id, 'again');
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
    for (let i = 0; i < 100; i++) {
      if (
        (await api.get(`/api/agents/${agent.id}`)).body.status.state === 'idle'
      )
        break;
      await sleep(20);
    }
    const before = (await api.get(`/api/agents/${agent.id}`)).body.agent;
    mark = events.mark();
    expect((await api.post(`/api/agents/${agent.id}/restart`)).status).toBe(
      201,
    );
    const after = (await api.get(`/api/agents/${agent.id}`)).body;
    expect(after.agent.currentSessionId).not.toBe(before.currentSessionId);
    expect(after.agent.vendorConversationId).toBe(before.vendorConversationId); // resumed, not started over
    expect(after.sessions).toHaveLength(2);
    await events.waitFor(
      (f) =>
        f.type === 'agent.item' &&
        f.agentId === agent.id &&
        f.item.item.kind === 'system' &&
        f.item.item.text.startsWith('session resumed'),
      10000,
      mark,
    );
    // busy: refused with the state, nothing restarted
    mark = events.mark();
    await api.post(`/api/agents/${agent.id}/turn`, { text: 'slow please' });
    await events.waitFor(
      (f) =>
        f.type === 'agent.state' &&
        f.agentId === agent.id &&
        f.status.state === 'working',
      10000,
      mark,
    );
    const busy = await api.post(`/api/agents/${agent.id}/restart`);
    expect(busy.status).toBe(409);
    expect(busy.body.message).toBe('agent is working');
    expect(
      (await api.get(`/api/agents/${agent.id}`)).body.agent.currentSessionId,
    ).toBe(after.agent.currentSessionId);
  }, 30000);

  it('stops and archives', async () => {
    const p = await createProject();
    const { agent } = await createAgent(p.id);
    expect((await api.post(`/api/agents/${agent.id}/stop`)).status).toBe(201);
    await events.waitFor(
      (f) =>
        f.type === 'agent.state' &&
        f.agentId === agent.id &&
        f.status.state === 'exited',
    );
    expect((await api.post(`/api/agents/${agent.id}/archive`)).status).toBe(
      201,
    );
    expect((await api.get(`/api/projects/${p.id}/agents`)).body).toEqual([]);
    expect(
      (await api.post(`/api/agents/${agent.id}/turn`, { text: 'x' })).status,
    ).toBe(409);
  });

  it('accepts a repo set, defaults the agent cwd to the primary repo, and resolves cwd by repo name', async () => {
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'am-second-'));
    const r = await api.post('/api/projects', {
      name: 'multi',
      repos: [{ path: projectDir }, { name: 'ui', path: second }],
      defaultProfile: 'fake',
    });
    expect(r.status).toBe(201);
    expect(r.body.project.repos.map((x: any) => x.name)).toEqual([
      path.basename(projectDir),
      'ui',
    ]);
    expect(r.body.project.path).toBe(projectDir);
    const a = await api.post(`/api/projects/${r.body.project.id}/agents`, {
      name: 'a',
    });
    expect(a.status).toBe(201);
    expect(fs.realpathSync(a.body.agent.cwd)).toBe(fs.realpathSync(projectDir));
    const b = await api.post(`/api/projects/${r.body.project.id}/agents`, {
      name: 'b',
      cwd: 'ui',
    });
    expect(b.status).toBe(201);
    expect(fs.realpathSync(b.body.agent.cwd)).toBe(fs.realpathSync(second));
    expect(
      (
        await api.post(`/api/projects/${r.body.project.id}/agents`, {
          name: 'c',
          cwd: 'elsewhere',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api.post('/api/projects', {
          name: 'dup',
          repos: [
            { name: 'x', path: projectDir },
            { name: 'x', path: second },
          ],
        })
      ).status,
    ).toBe(400);
    expect(
      (await api.post('/api/projects', { name: 'none', repos: [] })).status,
    ).toBe(400);
    const patched = await api.patch(`/api/projects/${r.body.project.id}`, {
      repos: [{ name: 'ui', path: second }],
    });
    expect(patched.status).toBe(200);
    expect(patched.body.project.repos).toEqual([{ name: 'ui', path: second }]);
    expect(patched.body.project.path).toBe(second);
    await api.delete(`/api/projects/${r.body.project.id}`);
  });

  it('validates', async () => {
    const p = await createProject();
    expect(
      (await api.post(`/api/projects/${p.id}/agents`, { profile: 'fake' }))
        .status,
    ).toBe(400);
    expect(
      (
        await api.post(`/api/projects/${p.id}/agents`, {
          name: 'x',
          profile: 'unknown',
        })
      ).status,
    ).toBe(400);
    expect((await api.get('/api/agents/nope')).status).toBe(404);
    const { agent } = await createAgent(p.id);
    expect((await api.post(`/api/agents/${agent.id}/turn`, {})).status).toBe(
      400,
    );
  });
});

describe('resilience', () => {
  it('recovers output produced while the daemon link was down, including an exit', async () => {
    const p = await createProject();
    const { agent } = await createAgent(p.id, 'linkdrop');
    const mark = events.mark();
    await api.post(`/api/agents/${agent.id}/turn`, { text: 'slow then exit' });
    await events.waitFor(
      (f) =>
        f.type === 'agent.state' &&
        f.agentId === agent.id &&
        f.status.state === 'working',
      10000,
      mark,
    );
    // drop only the manager's socket to the daemon; the agent keeps talking and then exits
    (m.app.get(DaemonClient) as unknown as { ws: WebSocket }).ws.terminate();
    await events.waitFor(
      (f) => f.type === 'daemon' && f.connected === false,
      10000,
      mark,
    );
    await events.waitFor(
      (f) => f.type === 'daemon' && f.connected === true,
      15000,
      mark,
    );
    await events.waitFor(
      (f) =>
        f.type === 'agent.state' &&
        f.agentId === agent.id &&
        f.status.state === 'exited',
      20000,
      mark,
    );
    const items = (await api.get(`/api/agents/${agent.id}/items`)).body
      .items as any[];
    const kinds = items.map((i) => i.item.kind);
    expect(kinds.slice(-3)).toEqual(['text', 'turn_end', 'system']); // the answer, its end, then the exit boundary
    expect(items[items.length - 3].item.streaming).toBe(false);
    expect(items[items.length - 1].item.text).toMatch(/^session ended/);
    expect(items.filter((i) => i.item.kind === 'user')).toHaveLength(1);
  }, 40000);

  it('stop breaks through a turn blocked on stdin the agent no longer reads', async () => {
    const p = await createProject();
    const { agent } = await createAgent(p.id, 'blocked');
    await api.post(`/api/agents/${agent.id}/turn`, {
      text: 'block stdin please',
    });
    await events.waitFor(
      (f) =>
        f.type === 'agent.item' &&
        f.agentId === agent.id &&
        f.item.item.kind === 'turn_end',
    );
    // a turn large enough to fill the pipe never gets its ok; it holds the agent's lock
    const stuck = api.post(`/api/agents/${agent.id}/turn`, {
      text: 'x'.repeat(512 * 1024),
    });
    await sleep(300);
    const t0 = Date.now();
    const stopped = await api.post(`/api/agents/${agent.id}/stop`);
    expect(stopped.status).toBe(201);
    expect(Date.now() - t0).toBeLessThan(8000);
    await events.waitFor(
      (f) =>
        f.type === 'agent.state' &&
        f.agentId === agent.id &&
        f.status.state === 'exited',
      10000,
    );
    const turn = await stuck;
    expect([503, 409]).toContain(turn.status);
  }, 30000);
});

describe('manager restart', () => {
  it('an archive right after a restart still ends a session the database had lost', async () => {
    const p = await createProject();
    const { agent } = await createAgent(p.id, 'lost-then-archived');
    await api.post(`/api/agents/${agent.id}/turn`, { text: 'one' });
    await events.waitFor(
      (f) =>
        f.type === 'agent.item' &&
        f.agentId === agent.id &&
        f.item.item.kind === 'turn_end',
    );
    const db = m.app.get(DbService).db;
    db.prepare('DELETE FROM agent_sessions WHERE agent_id = ?').run(agent.id);
    db.prepare('UPDATE agents SET current_session_id = NULL WHERE id = ?').run(
      agent.id,
    );
    await events.close();
    await m.stop();
    m = await startManager(daemon.url, m.dataDir);
    api = new Api(m.url);
    await api.login();
    events = await Events.connect(m.url, api.cookie);
    // no sleep: the archive must wait for adoption before deciding there is nothing to stop
    expect((await api.post(`/api/agents/${agent.id}/archive`)).status).toBe(
      201,
    );
    const rec = await new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(daemon.url);
      ws.on('open', () =>
        ws.send(
          JSON.stringify({
            type: 'session.get',
            ref: 1,
            id: agent.currentSessionId,
          }),
        ),
      );
      ws.on('message', (d) => (ws.close(), resolve(JSON.parse(String(d)))));
      ws.on('error', reject);
    });
    expect(rec.session.state).toBe('exited');
  }, 30000);

  it('a stop right after a restart yields one ended boundary, after the history', async () => {
    const p = await createProject();
    const { agent } = await createAgent(p.id, 'stop-after-restart');
    await api.post(`/api/agents/${agent.id}/turn`, { text: 'one' });
    await events.waitFor(
      (f) =>
        f.type === 'agent.item' &&
        f.agentId === agent.id &&
        f.item.item.kind === 'turn_end',
    );
    await events.close();
    await m.stop();
    m = await startManager(daemon.url, m.dataDir);
    api = new Api(m.url);
    await api.login();
    events = await Events.connect(m.url, api.cookie);
    // no sleep: the stop must wait for the resync, not race it
    expect((await api.post(`/api/agents/${agent.id}/stop`)).status).toBe(201);
    await events.waitFor(
      (f) =>
        f.type === 'agent.state' &&
        f.agentId === agent.id &&
        f.status.state === 'exited',
    );
    const kinds = (
      await api.get(`/api/agents/${agent.id}/items`)
    ).body.items.map((i: any) => i.item.kind);
    expect(kinds).toEqual(['system', 'user', 'text', 'turn_end', 'system']);
  }, 30000);

  it('creating an agent while the daemon is down fails cleanly and leaves nothing behind', async () => {
    const p = await createProject();
    const mark = events.mark();
    await daemon.stop('SIGKILL');
    await events.waitFor(
      (f) => f.type === 'daemon' && f.connected === false,
      10000,
      mark,
    );
    const r = await api.post(`/api/projects/${p.id}/agents`, { name: 'ghost' });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('agent-unavailable');
    expect((await api.get(`/api/projects/${p.id}/agents`)).body).toEqual([]);
    daemon = await startDaemon({ root: daemon.root, port: daemon.port });
    await events.waitFor(
      (f) => f.type === 'daemon' && f.connected === true,
      15000,
      mark,
    );
  }, 40000);

  it('keeps exited and archived agents right, and adopts a session the database lost', async () => {
    const p = await createProject();
    const { agent: exitedAgent } = await createAgent(p.id, 'exited');
    await api.post(`/api/agents/${exitedAgent.id}/turn`, { text: 'one' });
    await events.waitFor(
      (f) =>
        f.type === 'agent.item' &&
        f.agentId === exitedAgent.id &&
        f.item.item.kind === 'turn_end',
    );
    await api.post(`/api/agents/${exitedAgent.id}/stop`);
    await events.waitFor(
      (f) =>
        f.type === 'agent.state' &&
        f.agentId === exitedAgent.id &&
        f.status.state === 'exited',
    );

    const { agent: archived } = await createAgent(p.id, 'archived');
    await api.post(`/api/agents/${archived.id}/turn`, { text: 'kept' });
    await events.waitFor(
      (f) =>
        f.type === 'agent.item' &&
        f.agentId === archived.id &&
        f.item.item.kind === 'turn_end',
    );
    await api.post(`/api/agents/${archived.id}/archive`);

    const { agent: orphan } = await createAgent(p.id, 'orphan');
    await api.post(`/api/agents/${orphan.id}/turn`, { text: 'before crash' });
    await events.waitFor(
      (f) =>
        f.type === 'agent.item' &&
        f.agentId === orphan.id &&
        f.item.item.kind === 'turn_end',
    );
    // the manager "crashed" before it could record the session
    const db = m.app.get(DbService).db;
    db.prepare('DELETE FROM agent_sessions WHERE agent_id = ?').run(orphan.id);
    db.prepare('UPDATE agents SET current_session_id = NULL WHERE id = ?').run(
      orphan.id,
    );

    await events.close();
    await m.stop();
    m = await startManager(daemon.url, m.dataDir);
    api = new Api(m.url);
    await api.login();
    events = await Events.connect(m.url, api.cookie);
    await sleep(500);

    const e = await api.get(`/api/agents/${exitedAgent.id}`);
    expect(e.body.status.state).toBe('exited');
    expect(e.body.agent.currentSessionId).toBeNull();
    expect(
      (await api.get(`/api/agents/${exitedAgent.id}/items`)).body.items.map(
        (i: any) => i.item.kind,
      ),
    ).toEqual(['system', 'user', 'text', 'turn_end', 'system']);

    const a = (await api.get(`/api/agents/${archived.id}/items`)).body
      .items as any[];
    expect(a.map((i) => i.item.kind)).toContain('turn_end'); // archived history is still rebuilt

    const o = await api.get(`/api/agents/${orphan.id}`);
    expect(o.body.agent.currentSessionId).toBe(orphan.currentSessionId); // adopted, not restarted
    expect(o.body.status.state).toBe('idle');
    expect(o.body.sessions).toHaveLength(1);
    const adoptMark = events.mark();
    expect(
      (
        await api.post(`/api/agents/${orphan.id}/turn`, {
          text: 'after adoption',
        })
      ).status,
    ).toBe(202);
    await events.waitFor(
      (f) =>
        f.type === 'agent.item' &&
        f.agentId === orphan.id &&
        f.item.item.kind === 'user' &&
        f.item.item.text === 'after adoption',
      10000,
      adoptMark,
    );
    const end = await events.waitFor(
      (f) =>
        f.type === 'agent.item' &&
        f.agentId === orphan.id &&
        f.item.item.kind === 'turn_end',
      10000,
      adoptMark,
    );
    expect(end.item.sessionId).toBe(orphan.currentSessionId);
  }, 30000);

  it('survives a daemon restart: agents exit, and resume on the next turn', async () => {
    const p = await createProject();
    const { agent } = await createAgent(p.id, 'daemon-restart');
    await api.post(`/api/agents/${agent.id}/turn`, { text: 'before' });
    await events.waitFor(
      (f) =>
        f.type === 'agent.item' &&
        f.agentId === agent.id &&
        f.item.item.kind === 'turn_end',
    );
    const mark = events.mark();
    await daemon.stop('SIGKILL'); // a crash, not a clean stop: sessions are still 'running' on disk
    await events.waitFor(
      (f) => f.type === 'daemon' && f.connected === false,
      10000,
      mark,
    );
    // a turn sent while the link is down must resolve, not hang on the gate
    const duringOutage = api.post(`/api/agents/${agent.id}/turn`, {
      text: 'during outage',
    });
    daemon = await startDaemon({ root: daemon.root, port: daemon.port });
    await events.waitFor(
      (f) => f.type === 'daemon' && f.connected === true,
      15000,
      mark,
    );
    await events.waitFor(
      (f) =>
        f.type === 'agent.state' &&
        f.agentId === agent.id &&
        f.status.state === 'exited',
      15000,
      mark,
    );
    const outage = await duringOutage;
    expect([202, 503]).toContain(outage.status);
    const items = (await api.get(`/api/agents/${agent.id}/items`)).body
      .items as any[];
    expect(
      items.some(
        (i) =>
          i.item.kind === 'system' && i.item.text.includes('daemon-restart'),
      ),
    ).toBe(true);
    await api.post(`/api/agents/${agent.id}/turn`, { text: 'after' });
    await events.waitFor(
      (f) =>
        f.type === 'agent.item' &&
        f.agentId === agent.id &&
        f.item.item.kind === 'turn_end' &&
        f.item.sessionId !== agent.currentSessionId,
      15000,
      mark,
    );
    expect(
      (await api.get(`/api/agents/${agent.id}`)).body.sessions,
    ).toHaveLength(2);
  }, 40000);

  it('rebuilds agents, transcripts and states from the daemon', async () => {
    const p = await createProject();
    const { agent } = await createAgent(p.id, 'survivor');
    await api.post(`/api/agents/${agent.id}/turn`, { text: 'first turn' });
    await events.waitFor(
      (f) =>
        f.type === 'agent.item' &&
        f.agentId === agent.id &&
        f.item.item.kind === 'turn_end',
    );
    const before = (await api.get(`/api/agents/${agent.id}/items`)).body
      .items as any[];

    await events.close();
    await m.stop();
    m = await startManager(daemon.url, m.dataDir);
    api = new Api(m.url);
    await api.login();
    events = await Events.connect(m.url, api.cookie);
    await sleep(300); // resync runs on daemon connect

    const after = await api.get(`/api/agents/${agent.id}`);
    expect(after.body.status.state).toBe('idle');
    expect(after.body.agent.currentSessionId).toBe(agent.currentSessionId);
    const items = (await api.get(`/api/agents/${agent.id}/items`)).body
      .items as any[];
    expect(items.map((i) => i.item.kind)).toEqual(
      before.map((i) => i.item.kind),
    );
    expect(items.map((i) => i.item)).toEqual(before.map((i) => i.item));

    // and the live session still answers
    await api.post(`/api/agents/${agent.id}/turn`, { text: 'second turn' });
    await events.waitFor(
      (f) =>
        f.type === 'agent.item' &&
        f.agentId === agent.id &&
        f.item.item.kind === 'turn_end',
    );
    const final = (await api.get(`/api/agents/${agent.id}/items`)).body
      .items as any[];
    expect(final.length).toBe(before.length + 3);
    expect(final[final.length - 2].item.text).toContain('Turn 2 done');
  }, 30000);
});
