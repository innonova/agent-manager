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

describe('presence', () => {
  it('shows who is on an agent and who is typing; typing expires; a closed socket disappears', async () => {
    const created = await api.post('/api/users', { name: 'bob' });
    const bob = new Api(m.url);
    await bob.login('bob', created.body.password);
    const admin = await Events.connect(m.url, api.cookie);
    const bobEvents = await Events.connect(m.url, bob.cookie);
    const presence = (from: number, pred: (agents: any) => boolean) =>
      admin.waitFor(
        (f) => f.type === 'presence' && pred(f.agents),
        10000,
        from,
      );

    let mark = admin.mark();
    bobEvents.ws.send(
      JSON.stringify({ type: 'presence', agentId: 'agent-1', typing: false }),
    );
    let f = await presence(mark, (a) => a['agent-1']?.length === 1);
    expect(f.agents['agent-1']).toEqual([
      { userId: created.body.user.id, name: 'bob', typing: false },
    ]);

    mark = admin.mark();
    bobEvents.ws.send(
      JSON.stringify({ type: 'presence', agentId: 'agent-1', typing: true }),
    );
    f = await presence(mark, (a) => a['agent-1']?.[0]?.typing === true);
    expect(f.agents['agent-1'][0].typing).toBe(true);

    // a fresh client learns the picture from hello
    const late = await Events.connect(m.url, api.cookie);
    const hello = late.frames.find((x) => x.type === 'hello');
    expect(hello.presence['agent-1'][0]).toMatchObject({
      name: 'bob',
      typing: true,
    });
    await late.close();

    // typing expires without a repeat
    mark = admin.mark();
    f = await presence(mark, (a) => a['agent-1']?.[0]?.typing === false);
    expect(f.agents['agent-1'][0].typing).toBe(false);

    // two tabs of one user count once; leaving clears
    const bob2 = await Events.connect(m.url, bob.cookie);
    bob2.ws.send(
      JSON.stringify({ type: 'presence', agentId: 'agent-1', typing: false }),
    );
    await sleep(200);
    expect(
      admin.frames.filter((x) => x.type === 'presence').pop().agents['agent-1'],
    ).toHaveLength(1);
    mark = admin.mark();
    bobEvents.ws.send(
      JSON.stringify({ type: 'presence', agentId: null, typing: false }),
    );
    await sleep(200); // bob2 still there: no change broadcast
    await bob2.close();
    f = await presence(mark, (a) => !a['agent-1']);
    expect(f.agents).toEqual({});

    await bobEvents.close();
    await admin.close();
  }, 30000);
});
