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
    const items = (await api.get(`/api/agents/${agent.id}/items`)).body
      .items as any[];
    expect(items[items.length - 1].item.text).toContain('daemon-restart');
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
