import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentsService } from '../src/agents/agents.service.js';
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
let projectId: string;

const stateOf = (agentId: string, st: string, from = 0) =>
  events.waitFor(
    (f) =>
      f.type === 'agent.state' &&
      f.agentId === agentId &&
      f.status.state === st,
    10000,
    from,
  );
const itemOf = (agentId: string, pred: (item: any) => boolean, from = 0) =>
  events.waitFor(
    (f) =>
      f.type === 'agent.item' && f.agentId === agentId && pred(f.item.item),
    10000,
    from,
  );

beforeAll(async () => {
  daemon = await startDaemon();
  m = await startManager(daemon.url);
  api = new Api(m.url);
  await api.login();
  events = await Events.connect(m.url, api.cookie);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-perm-'));
  projectId = (await api.post('/api/projects', { name: 'perm', path: dir }))
    .body.project.id;
}, 30000);

afterAll(async () => {
  await events?.close();
  await m?.stop();
  await daemon?.stop();
});

describe('background watchdog', () => {
  it('an agent idle with background jobs and no activity is asked to check on them', async () => {
    const m2 = await startManager(daemon.url, undefined, {
      backgroundPokeMs: 300,
    });
    const api2 = new Api(m2.url);
    await api2.login();
    const ev = await Events.connect(m2.url, api2.cookie);
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-poke-'));
      const project = (
        await api2.post('/api/projects', { name: 'poke', path: dir })
      ).body.project;
      const agent = (
        await api2.post(`/api/projects/${project.id}/agents`, {
          name: 'bg',
          profile: 'fake',
        })
      ).body.agent;
      await ev.waitFor(
        (f) =>
          f.type === 'agent.state' &&
          f.agentId === agent.id &&
          f.status.state === 'idle',
        10000,
      );
      let mark = ev.mark();
      await api2.post(`/api/agents/${agent.id}/turn`, {
        text: 'start a background job',
      });
      await ev.waitFor(
        (f) =>
          f.type === 'agent.state' &&
          f.agentId === agent.id &&
          f.status.state === 'idle' &&
          f.status.background === 1,
        10000,
        mark,
      );
      // the watchdog runs every minute in production; here it is driven directly
      mark = ev.mark();
      await sleep(400);
      await (m2.app.get(AgentsService) as any).pokeStalled();
      const poke = await ev.waitFor(
        (f) =>
          f.type === 'agent.item' &&
          f.agentId === agent.id &&
          f.item.item.kind === 'user' &&
          /background job/.test(f.item.item.text),
        10000,
        mark,
      );
      expect(poke.item.item.by).toBeUndefined(); // the manager asked, not a user
      await ev.waitFor(
        (f) =>
          f.type === 'agent.state' &&
          f.agentId === agent.id &&
          f.status.state === 'idle' &&
          f.status.background === 0,
        10000,
        mark,
      );
      const items = (await api2.get(`/api/agents/${agent.id}/items`)).body
        .items;
      expect(
        items.every((i: any) => typeof i.at === 'number' && i.at > 0),
      ).toBe(true);
    } finally {
      await ev.close();
      await m2.stop();
    }
  }, 30000);
});

describe('permissions', () => {
  it('a model chosen at creation reaches the session and the status reports the active one', async () => {
    const r = await api.post(`/api/projects/${projectId}/agents`, {
      name: 'picky',
      profile: 'fake',
      model: 'fake-2',
      effort: 'high',
    });
    expect(r.status).toBe(201);
    expect(r.body.agent).toMatchObject({ model: 'fake-2', effort: 'high' });
    const id = r.body.agent.id as string;
    await stateOf(id, 'idle');
    expect((await api.get(`/api/agents/${id}`)).body.status.model).toBe(
      'fake-2',
    );
    const plain = await api.post(`/api/projects/${projectId}/agents`, {
      name: 'plain',
      profile: 'fake',
    });
    await stateOf(plain.body.agent.id, 'idle');
    expect(
      (await api.get(`/api/agents/${plain.body.agent.id}`)).body.status.model,
    ).toBe('fake-1');
    expect(
      (
        await api.post(`/api/projects/${projectId}/agents`, {
          name: 'x',
          profile: 'fake',
          model: 'no spaces',
        })
      ).status,
    ).toBe(400);
  });

  it('defaults to bypass and validates the value', async () => {
    const r = await api.post(`/api/projects/${projectId}/agents`, {
      name: 'free',
      profile: 'fake',
    });
    expect(r.status).toBe(201);
    expect(r.body.agent.permissions).toBe('bypass');
    const bad = await api.post(`/api/projects/${projectId}/agents`, {
      name: 'x',
      profile: 'fake',
      permissions: 'maybe',
    });
    expect(bad.status).toBe(400);
  });

  it('an ask agent waits on a permission item; allow and deny answer it; unknown requests are 404', async () => {
    const created = await api.post(`/api/projects/${projectId}/agents`, {
      name: 'careful',
      profile: 'fake',
      permissions: 'ask',
    });
    expect(created.body.agent.permissions).toBe('ask');
    const id = created.body.agent.id as string;
    await stateOf(id, 'idle');

    let mark = events.mark();
    await api.post(`/api/agents/${id}/turn`, { text: 'this needs permission' });
    await stateOf(id, 'waiting-permission', mark);
    const asked = await itemOf(
      id,
      (i) => i.kind === 'permission' && i.decision === null,
      mark,
    );
    const perm = asked.item.item;
    expect(perm).toMatchObject({
      tool: 'Bash',
      title: 'Remove the build directory',
      input: { command: 'rm -rf dist' },
    });
    expect(perm.options.map((o: any) => o.kind)).toEqual([
      'allow',
      'allow-always',
      'deny',
    ]);
    // a turn cannot be sent meanwhile
    expect(
      (await api.post(`/api/agents/${id}/turn`, { text: 'hurry' })).status,
    ).toBe(409);
    expect(
      (
        await api.post(`/api/agents/${id}/permission`, {
          requestId: 'nope',
          option: 'allow',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api.post(`/api/agents/${id}/permission`, {
          requestId: perm.requestId,
          option: 'maybe',
        })
      ).status,
    ).toBe(404);

    mark = events.mark();
    const ok = await api.post(`/api/agents/${id}/permission`, {
      requestId: perm.requestId,
      option: 'allow',
    });
    expect(ok.status).toBe(201);
    const decided = await itemOf(
      id,
      (i) => i.kind === 'permission' && i.decision === 'allow',
      mark,
    );
    expect(decided.item.index).toBe(asked.item.index); // the same item, updated in place
    await stateOf(id, 'idle', mark);
    const items = (await api.get(`/api/agents/${id}/items`)).body.items.map(
      (i: any) => i.item,
    );
    expect(items.filter((i: any) => i.kind === 'text').pop().text).toContain(
      'Removed it (allow)',
    );
    // answering again is refused: nothing pending
    expect(
      (
        await api.post(`/api/agents/${id}/permission`, {
          requestId: perm.requestId,
          option: 'allow',
        })
      ).status,
    ).toBe(404);

    mark = events.mark();
    await api.post(`/api/agents/${id}/turn`, { text: 'permission once more' });
    const again = await itemOf(
      id,
      (i) => i.kind === 'permission' && i.decision === null,
      mark,
    );
    await api.post(`/api/agents/${id}/permission`, {
      requestId: again.item.item.requestId,
      option: 'deny',
    });
    await stateOf(id, 'idle', mark);
    const after = (await api.get(`/api/agents/${id}/items`)).body.items.map(
      (i: any) => i.item,
    );
    expect(after.filter((i: any) => i.kind === 'text').pop().text).toContain(
      'not removing it',
    );
  });

  it('the activity is `waiting` while a permission is pending, and clears once it is answered', async () => {
    const created = await api.post(`/api/projects/${projectId}/agents`, {
      name: 'watched',
      profile: 'fake',
      permissions: 'ask',
    });
    const id = created.body.agent.id as string;
    await stateOf(id, 'idle');

    const mark = events.mark();
    await api.post(`/api/agents/${id}/turn`, { text: 'this needs permission' });
    await stateOf(id, 'waiting-permission', mark);
    const asked = await itemOf(
      id,
      (i) => i.kind === 'permission' && i.decision === null,
      mark,
    );
    let status = (await api.get(`/api/agents/${id}`)).body.status;
    expect(status.activity).toMatchObject({ kind: 'waiting' });

    await api.post(`/api/agents/${id}/permission`, {
      requestId: asked.item.item.requestId,
      option: 'allow',
    });
    await stateOf(id, 'idle', mark);
    status = (await api.get(`/api/agents/${id}`)).body.status;
    expect(status.activity).toBeNull();
  });

  it('a pending request survives a manager restart: the answer still reaches the agent', async () => {
    const created = await api.post(`/api/projects/${projectId}/agents`, {
      name: 'patient',
      profile: 'fake',
      permissions: 'ask',
    });
    const id = created.body.agent.id as string;
    await stateOf(id, 'idle');
    const mark = events.mark();
    await api.post(`/api/agents/${id}/turn`, { text: 'permission please' });
    const asked = await itemOf(
      id,
      (i) => i.kind === 'permission' && i.decision === null,
      mark,
    );

    await events.close();
    await m.stop();
    m = await startManager(daemon.url, m.dataDir);
    api = new Api(m.url);
    await api.login();
    events = await Events.connect(m.url, api.cookie);
    await sleep(500);
    expect((await api.get(`/api/agents/${id}`)).body.status.state).toBe(
      'waiting-permission',
    );

    const mark2 = events.mark();
    const r = await api.post(`/api/agents/${id}/permission`, {
      requestId: asked.item.item.requestId,
      option: 'allow-always',
    });
    expect(r.status).toBe(201);
    await stateOf(id, 'idle', mark2);
    const items = (await api.get(`/api/agents/${id}/items`)).body.items.map(
      (i: any) => i.item,
    );
    expect(items.find((i: any) => i.kind === 'permission').decision).toBe(
      'allow-always',
    );
    expect(items.filter((i: any) => i.kind === 'text').pop().text).toContain(
      'allow-always',
    );
  }, 30000);
});
