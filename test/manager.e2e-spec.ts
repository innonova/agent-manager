import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  return r.body.project as { id: string };
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
    expect((await anon.post('/api/auth/logout')).status).toBe(201);
    expect((await anon.get('/api/auth/me')).status).toBe(401);
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

  it('lists daemon profiles with adapter support', async () => {
    const r = await api.get('/api/profiles');
    expect(r.body.profiles).toEqual([
      expect.objectContaining({ name: 'fake', supported: true }),
    ]);
  });
});

describe('agents', () => {
  it('creates an agent with a live session and streams a turn as items', async () => {
    const p = await createProject();
    events.clear();
    const { agent, status } = await createAgent(p.id, 'worker');
    expect(status.state).toBe('idle');
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

    // a new turn clears the error state
    await api.post(`/api/agents/${agent.id}/turn`, { text: 'slow please' });
    await events.waitFor(
      (f) =>
        f.type === 'agent.state' &&
        f.agentId === agent.id &&
        f.status.state === 'working',
    );
    await sleep(100);
    expect((await api.post(`/api/agents/${agent.id}/interrupt`)).status).toBe(
      201,
    );
    await events.waitFor(
      (f) =>
        f.type === 'agent.state' &&
        f.agentId === agent.id &&
        f.status.state === 'idle',
      15000,
    );
    kinds = (await api.get(`/api/agents/${agent.id}/items`)).body.items.map(
      (i: any) => i.item.kind,
    );
    expect(kinds.filter((k: string) => k === 'error')).toHaveLength(1);
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

    await api.post(`/api/agents/${agent.id}/turn`, { text: 'back again' });
    await events.waitFor(
      (f) =>
        f.type === 'agent.item' &&
        f.agentId === agent.id &&
        f.item.item.kind === 'turn_end' &&
        f.item.sessionId !== first,
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

describe('manager restart', () => {
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
