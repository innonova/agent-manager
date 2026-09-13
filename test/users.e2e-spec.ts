import {
  Api,
  Events,
  TestDaemon,
  TestManager,
  startDaemon,
  startManager,
} from './helpers.js';

let daemon: TestDaemon;
let m: TestManager;
let api: Api;

beforeAll(async () => {
  daemon = await startDaemon();
  m = await startManager(daemon.url);
  api = new Api(m.url);
  await api.login();
}, 30000);

afterAll(async () => {
  await m?.stop();
  await daemon?.stop();
});

describe('turn attribution', () => {
  it("user turns carry the sender's name, from either user, and survive a rebuild", async () => {
    const created = await api.post('/api/users', { name: 'zed' });
    const zed = new Api(m.url);
    await zed.login('zed', created.body.password);
    const project = (
      await api.post('/api/projects', { name: 'attr', path: process.cwd() })
    ).body.project;
    const agent = (
      await api.post(`/api/projects/${project.id}/agents`, {
        name: 'a',
        profile: 'fake',
      })
    ).body.agent;
    const events = await Events.connect(m.url, api.cookie);
    const turnEnd = (from: number) =>
      events.waitFor(
        (f) =>
          f.type === 'agent.item' &&
          f.agentId === agent.id &&
          f.item.item.kind === 'turn_end',
        10000,
        from,
      );
    let mark = events.mark();
    await api.post(`/api/agents/${agent.id}/turn`, { text: 'from admin' });
    await turnEnd(mark);
    mark = events.mark();
    await zed.post(`/api/agents/${agent.id}/turn`, { text: 'from zed' });
    await turnEnd(mark);
    const by = async (client: Api) =>
      (await client.get(`/api/agents/${agent.id}/items`)).body.items
        .map((i: any) => i.item)
        .filter((i: any) => i.kind === 'user')
        .map((i: any) => `${i.by}:${i.text}`);
    expect(await by(api)).toEqual(['admin:from admin', 'zed:from zed']);
    await events.close();

    await m.stop();
    m = await startManager(daemon.url, m.dataDir);
    api = new Api(m.url);
    await api.login();
    await new Promise((r) => setTimeout(r, 500));
    expect(await by(api)).toEqual(['admin:from admin', 'zed:from zed']);
    await api.delete(`/api/users/${created.body.user.id}`);
  }, 30000);
});

describe('users', () => {
  it('lists users; the initial admin has logged in', async () => {
    const r = await api.get('/api/users');
    expect(r.status).toBe(200);
    expect(r.body.users).toHaveLength(1);
    expect(r.body.users[0]).toMatchObject({ name: 'admin' });
    expect(typeof r.body.users[0].lastLoginAt).toBe('number');
  });

  it('creates an account with a generated password that works, shown once; validates names', async () => {
    const r = await api.post('/api/users', { name: 'bob' });
    expect(r.status).toBe(201);
    expect(r.body.user).toMatchObject({ name: 'bob', lastLoginAt: null });
    expect(r.body.password).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
    const bob = new Api(m.url);
    await bob.login('bob', r.body.password);
    expect((await bob.get('/api/auth/me')).body.user.name).toBe('bob');
    expect((await api.post('/api/users', { name: 'bob' })).status).toBe(409);
    expect((await api.post('/api/users', { name: 'no spaces' })).status).toBe(
      400,
    );
    expect((await api.post('/api/users', {})).status).toBe(400);
    const list = await api.get('/api/users');
    expect(list.body.users.map((u: any) => u.name)).toEqual(['admin', 'bob']);
  });

  it('a user renames only themselves; names stay unique', async () => {
    const bob = new Api(m.url);
    const created = await api.post('/api/users', { name: 'carol' });
    await bob.login('carol', created.body.password);
    const r = await bob.patch('/api/users/me', { name: 'caroline' });
    expect(r.status).toBe(200);
    expect(r.body.user.name).toBe('caroline');
    expect((await bob.get('/api/auth/me')).body.user.name).toBe('caroline');
    expect((await bob.patch('/api/users/me', { name: 'admin' })).status).toBe(
      409,
    );
    expect((await bob.patch('/api/users/me', { name: '' })).status).toBe(400);
  });

  it("resetting a password ends the user's other sessions but not the caller's own", async () => {
    const created = await api.post('/api/users', { name: 'dave' });
    const daveId = created.body.user.id;
    const dave = new Api(m.url);
    await dave.login('dave', created.body.password);
    const events = await Events.connect(m.url, dave.cookie);
    const closed = new Promise<number>((resolve) =>
      events.ws.once('close', (code) => resolve(code)),
    );

    const reset = await api.post(`/api/users/${daveId}/password`);
    expect(reset.status).toBe(201);
    expect(reset.body.password).not.toBe(created.body.password);
    expect((await dave.get('/api/auth/me')).status).toBe(401); // old session gone
    expect(await closed).toBe(4401); // and its socket closed
    const again = new Api(m.url);
    await again.login('dave', reset.body.password);
    expect((await again.get('/api/auth/me')).body.user.name).toBe('dave');

    // self-reset keeps the current session
    const me = (await api.get('/api/auth/me')).body.user.id;
    const own = await api.post(`/api/users/${me}/password`);
    expect(own.status).toBe(201);
    expect((await api.get('/api/auth/me')).status).toBe(200);
    expect((await api.post('/api/users/nope/password')).status).toBe(404);
  });

  it('removes a user (not yourself, not the last one) and ends their sessions', async () => {
    const created = await api.post('/api/users', { name: 'erin' });
    const erin = new Api(m.url);
    await erin.login('erin', created.body.password);
    const me = (await api.get('/api/auth/me')).body.user.id;
    expect((await api.delete(`/api/users/${me}`)).status).toBe(409);
    const r = await api.delete(`/api/users/${created.body.user.id}`);
    expect(r.status).toBe(200);
    expect((await erin.get('/api/auth/me')).status).toBe(401);
    expect(
      (await api.delete(`/api/users/${created.body.user.id}`)).status,
    ).toBe(404);
    // remove everyone else, then the last one cannot go
    for (const u of (await api.get('/api/users')).body.users)
      if (u.id !== me) await api.delete(`/api/users/${u.id}`);
    expect((await api.get('/api/users')).body.users).toHaveLength(1);
  });
});
