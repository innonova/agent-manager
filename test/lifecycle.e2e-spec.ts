import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptedDaemon } from './scripted-daemon.js';
import { Api, Events, TestManager, sleep, startManager } from './helpers.js';

/**
 * Lifecycle tests: the manager against a daemon the test drives frame by
 * frame, with a scripted Codex behind it. These are the cases the review
 * rounds found by hand: handshake cut points, permission delivery,
 * refused interrupts, recovered attribution, a restart while waiting.
 */
let daemon: ScriptedDaemon;
let m: TestManager;
let api: Api;
let events: Events;
let projectId: string;

/** A minimal Codex app-server: answers the handshake and runs a turn that asks for approval when told. */
function scriptCodex(
  d: ScriptedDaemon,
  opts: {
    approvalOnTurn?: boolean;
    failInterrupt?: boolean;
    /** Start turns but never finish them; the test calls finishTurn itself. */
    holdTurn?: boolean;
  } = {},
) {
  d.on('input', (sid, line: any) => {
    if (line?.method === 'initialize')
      d.out(sid, {
        jsonrpc: '2.0',
        id: line.id,
        result: { userAgent: 'scripted' },
      });
    if (line?.method === 'thread/start' || line?.method === 'thread/resume') {
      d.out(sid, {
        jsonrpc: '2.0',
        id: line.id,
        result: { thread: { id: 'thread-1' } },
      });
      d.out(sid, {
        method: 'thread/started',
        params: { thread: { id: 'thread-1', model: 'scripted-1' } },
      });
    }
    if (line?.method === 'turn/start') {
      d.out(sid, {
        jsonrpc: '2.0',
        id: line.id,
        result: { turn: { id: 'turn-1' } },
      });
      d.out(sid, {
        method: 'turn/started',
        params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
      });
      if (opts.approvalOnTurn)
        d.out(sid, {
          method: 'item/commandExecution/requestApproval',
          id: 0,
          params: {
            command: 'rm -rf dist',
            availableDecisions: ['accept', 'cancel'],
          },
        });
      else if (!opts.holdTurn) finishTurn(d, sid);
    }
    if (line?.method === 'turn/interrupt') {
      if (opts.failInterrupt)
        d.out(sid, {
          jsonrpc: '2.0',
          id: line.id,
          error: { message: 'cannot interrupt now' },
        });
      else {
        d.out(sid, { jsonrpc: '2.0', id: line.id, result: {} });
        finishTurn(d, sid, 'interrupted');
      }
    }
    // our approval decision: the command runs and the turn ends
    if (line?.id === 0 && line.result?.decision !== undefined)
      finishTurn(d, sid);
  });
}
function finishTurn(d: ScriptedDaemon, sid: string, status = 'completed') {
  d.out(sid, {
    method: 'item/completed',
    params: { item: { type: 'agentMessage', id: 'msg-1', text: 'done' } },
  });
  d.out(sid, {
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'turn-1', status } },
  });
}

const stateOf = (agentId: string, st: string, from = 0) =>
  events.waitFor(
    (f) =>
      f.type === 'agent.state' &&
      f.agentId === agentId &&
      f.status.state === st,
    10000,
    from,
  );
const itemOf = (agentId: string, pred: (i: any) => boolean, from = 0) =>
  events.waitFor(
    (f) =>
      f.type === 'agent.item' && f.agentId === agentId && pred(f.item.item),
    10000,
    from,
  );

/** A small resident tail, so the cache is on the path of every test here. */
const managerOverrides = { residentItems: 6 };

async function restartManager() {
  await events.close();
  await m.stop();
  m = await startManager(daemon.url, m.dataDir, managerOverrides);
  api = new Api(m.url);
  await api.login();
  events = await Events.connect(m.url, api.cookie);
  await sleep(500); // the resync
}

async function newAgent(
  name: string,
  permissions: 'bypass' | 'ask' = 'bypass',
) {
  const r = await api.post(`/api/projects/${projectId}/agents`, {
    name,
    profile: 'codex',
    permissions,
  });
  expect(r.status).toBe(201);
  const id = r.body.agent.id as string;
  await stateOf(id, 'idle');
  return id;
}
/** Polls the REST status: for states reached during a resync, before this test's socket existed. */
async function untilState(
  agentId: string,
  st: string,
  ms = 10000,
): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await api.get(`/api/agents/${agentId}`)).body.status.state === st)
      return;
    await sleep(50);
  }
  throw new Error(`agent ${agentId} did not reach ${st}`);
}
const sessionOf = async (agentId: string) =>
  (await api.get(`/api/agents/${agentId}`)).body.agent
    .currentSessionId as string;
const methods = (sid: string) =>
  daemon.inputs(sid).map((l: any) => l.method ?? `reply:${l.id}`);

beforeAll(async () => {
  daemon = await ScriptedDaemon.start();
  m = await startManager(daemon.url, undefined, managerOverrides);
  api = new Api(m.url);
  await api.login();
  events = await Events.connect(m.url, api.cookie);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-life-'));
  projectId = (await api.post('/api/projects', { name: 'life', path: dir }))
    .body.project.id;
}, 30000);

afterAll(async () => {
  await events?.close();
  await m?.stop();
  await daemon?.stop();
});

describe('handshake cut points', () => {
  it('a new session gets exactly one handshake and becomes idle', async () => {
    scriptCodex(daemon);
    const id = await newAgent('h0');
    expect(methods(await sessionOf(id))).toEqual([
      'initialize',
      'initialized',
      'thread/start',
    ]);
    expect((await api.get(`/api/agents/${id}`)).body.status.model).toBe(
      'scripted-1',
    );
    daemon.removeAllListeners('input');
  }, 30000);

  it('cut with initialize logged but unanswered: the manager waits and does not repeat it', async () => {
    // no script: initialize gets no reply
    const r = await api.post(`/api/projects/${projectId}/agents`, {
      name: 'h1',
      profile: 'codex',
    });
    const id = r.body.agent.id as string;
    await sleep(200);
    const sid = await sessionOf(id);
    expect(methods(sid)).toEqual(['initialize']);
    await restartManager();
    await sleep(300);
    expect(methods(sid)).toEqual(['initialize']); // not sent again
    // the reply now arrives: the manager owes the rest, once
    scriptCodex(daemon);
    daemon.out(sid, {
      jsonrpc: '2.0',
      id: 1,
      result: { userAgent: 'scripted' },
    });
    await stateOf(id, 'idle');
    expect(methods(sid)).toEqual(['initialize', 'initialized', 'thread/start']);
    daemon.removeAllListeners('input');
  }, 30000);

  it('cut with initialize answered but no thread request: only the follow-up is sent after the replay', async () => {
    const r = await api.post(`/api/projects/${projectId}/agents`, {
      name: 'h2',
      profile: 'codex',
    });
    const id = r.body.agent.id as string;
    await sleep(200);
    const sid = await sessionOf(id);
    daemon.cut(); // the manager is gone...
    daemon.out(sid, {
      jsonrpc: '2.0',
      id: 1,
      result: { userAgent: 'scripted' },
    }); // ...when the reply lands
    scriptCodex(daemon);
    await restartManager();
    await untilState(id, 'idle'); // may already be idle from the resync, before our socket
    expect(methods(sid)).toEqual(['initialize', 'initialized', 'thread/start']);
    daemon.removeAllListeners('input');
  }, 30000);

  it('everything logged: a restart sends nothing', async () => {
    scriptCodex(daemon);
    const id = await newAgent('h3');
    const sid = await sessionOf(id);
    await restartManager();
    await sleep(300);
    expect(methods(sid)).toEqual(['initialize', 'initialized', 'thread/start']);
    expect((await api.get(`/api/agents/${id}`)).body.status.state).toBe('idle');
    daemon.removeAllListeners('input');
  });
});

describe('permission delivery', () => {
  it('an answer refused by the daemon can be given again; a delivered one cannot', async () => {
    scriptCodex(daemon, { approvalOnTurn: true });
    const id = await newAgent('p1', 'ask');
    let mark = events.mark();
    await api.post(`/api/agents/${id}/turn`, { text: 'do it' });
    const asked = await itemOf(
      id,
      (i) => i.kind === 'permission' && i.decision === null,
      mark,
    );
    const requestId = asked.item.item.requestId;
    daemon.onInput = () => 'refuse';
    const refused = await api.post(`/api/agents/${id}/permission`, {
      requestId,
      option: 'allow',
    });
    expect(refused.status).toBeGreaterThanOrEqual(500);
    daemon.onInput = null;
    mark = events.mark();
    const ok = await api.post(`/api/agents/${id}/permission`, {
      requestId,
      option: 'allow',
    });
    expect(ok.status).toBe(201);
    await itemOf(
      id,
      (i) => i.kind === 'permission' && i.decision === 'allow',
      mark,
    );
    await stateOf(id, 'idle', mark);
    expect(
      (
        await api.post(`/api/agents/${id}/permission`, {
          requestId,
          option: 'deny',
        })
      ).status,
    ).toBe(404);
    daemon.removeAllListeners('input');
  }, 30000);

  it('an answer lost with the connection before it was recorded can be given again after the replay', async () => {
    scriptCodex(daemon, { approvalOnTurn: true });
    const id = await newAgent('p2', 'ask');
    let mark = events.mark();
    await api.post(`/api/agents/${id}/turn`, { text: 'do it' });
    const asked = await itemOf(
      id,
      (i) => i.kind === 'permission' && i.decision === null,
      mark,
    );
    const requestId = asked.item.item.requestId;
    daemon.onInput = () => 'cut-before';
    const lost = await api.post(`/api/agents/${id}/permission`, {
      requestId,
      option: 'allow',
    });
    expect(lost.status).toBeGreaterThanOrEqual(500);
    daemon.onInput = null;
    await sleep(1500); // the manager reconnects and replays; the log has no answer
    mark = events.mark();
    const again = await api.post(`/api/agents/${id}/permission`, {
      requestId,
      option: 'allow',
    });
    expect(again.status).toBe(201);
    await stateOf(id, 'idle', mark);
    daemon.removeAllListeners('input');
  }, 30000);

  it('an answer recorded but unacknowledged is found in the replay: the second attempt is refused', async () => {
    scriptCodex(daemon, { approvalOnTurn: true });
    const id = await newAgent('p3', 'ask');
    const mark = events.mark();
    await api.post(`/api/agents/${id}/turn`, { text: 'do it' });
    const asked = await itemOf(
      id,
      (i) => i.kind === 'permission' && i.decision === null,
      mark,
    );
    const requestId = asked.item.item.requestId;
    daemon.onInput = () => 'cut-after';
    const lost = await api.post(`/api/agents/${id}/permission`, {
      requestId,
      option: 'allow',
    });
    expect(lost.status).toBeGreaterThanOrEqual(500);
    daemon.onInput = null;
    await sleep(1500);
    expect(
      (
        await api.post(`/api/agents/${id}/permission`, {
          requestId,
          option: 'allow',
        })
      ).status,
    ).toBe(404);
    const items = (await api.get(`/api/agents/${id}/items`)).body.items.map(
      (i: any) => i.item,
    );
    expect(items.find((i: any) => i.kind === 'permission').decision).toBe(
      'allow',
    );
    daemon.removeAllListeners('input');
  }, 30000);

  it('a restart while waiting keeps the request pending and answerable', async () => {
    scriptCodex(daemon, { approvalOnTurn: true });
    const id = await newAgent('p4', 'ask');
    let mark = events.mark();
    await api.post(`/api/agents/${id}/turn`, { text: 'do it' });
    const asked = await itemOf(
      id,
      (i) => i.kind === 'permission' && i.decision === null,
      mark,
    );
    await restartManager();
    expect((await api.get(`/api/agents/${id}`)).body.status.state).toBe(
      'waiting-permission',
    );
    mark = events.mark();
    const r = await api.post(`/api/agents/${id}/permission`, {
      requestId: asked.item.item.requestId,
      option: 'allow',
    });
    expect(r.status).toBe(201);
    await stateOf(id, 'idle', mark);
    daemon.removeAllListeners('input');
  });
});

describe('interrupts and attribution', () => {
  it('a rejected interrupt leaves the turn open; another turn is refused', async () => {
    let approve = false;
    daemon.on('input', (sid, line: any) => {
      if (line?.method === 'initialize')
        daemon.out(sid, { jsonrpc: '2.0', id: line.id, result: {} });
      if (line?.method === 'thread/start')
        daemon.out(sid, {
          jsonrpc: '2.0',
          id: line.id,
          result: { thread: { id: 't' } },
        });
      if (line?.method === 'turn/start') {
        daemon.out(sid, {
          jsonrpc: '2.0',
          id: line.id,
          result: { turn: { id: 'turn-x' } },
        });
        daemon.out(sid, {
          method: 'turn/started',
          params: { turn: { id: 'turn-x' } },
        });
        // never completes by itself
      }
      if (line?.method === 'turn/interrupt')
        daemon.out(sid, {
          jsonrpc: '2.0',
          id: line.id,
          error: { message: 'cannot interrupt now' },
        });
      void approve;
    });
    const id = await newAgent('i1');
    const mark = events.mark();
    await api.post(`/api/agents/${id}/turn`, { text: 'long one' });
    await stateOf(id, 'working', mark);
    expect((await api.post(`/api/agents/${id}/interrupt`)).status).toBe(201);
    await sleep(200);
    expect((await api.get(`/api/agents/${id}`)).body.status.state).toBe(
      'working',
    );
    expect(
      (await api.post(`/api/agents/${id}/turn`, { text: 'another' })).status,
    ).toBe(409);
    daemon.removeAllListeners('input');
    approve = true;
  }, 30000);

  it('a turn recorded but unacknowledged is attributed after the replay; one never recorded lends no author', async () => {
    scriptCodex(daemon);
    const id = await newAgent('a1');
    const bobPw = (await api.post('/api/users', { name: 'bob' })).body.password;
    const bob = new Api(m.url);
    await bob.login('bob', bobPw);
    // admin's turn is recorded, the acknowledgement lost
    daemon.onInput = (_, line: any) =>
      line?.method === 'turn/start' ? 'cut-after' : 'ok';
    const lost = await api.post(`/api/agents/${id}/turn`, {
      text: 'from admin',
    });
    expect(lost.status).toBeGreaterThanOrEqual(500);
    daemon.onInput = null;
    await sleep(1500); // reconnect, replay: the recorded turn gets its author
    let items = (await api.get(`/api/agents/${id}/items`)).body.items.map(
      (i: any) => i.item,
    );
    expect(
      items
        .filter((i: any) => i.kind === 'user')
        .map((i: any) => `${i.by}:${i.text}`),
    ).toEqual(['admin:from admin']);
    await stateOf(id, 'idle');
    // bob's turn is never recorded; admin's leftover author must not land on the next turn
    daemon.onInput = (_, line: any) =>
      line?.method === 'turn/start' ? 'cut-before' : 'ok';
    expect(
      (await bob.post(`/api/agents/${id}/turn`, { text: 'lost' })).status,
    ).toBeGreaterThanOrEqual(500);
    daemon.onInput = null;
    await sleep(1500);
    const mark = events.mark();
    await bob.post(`/api/agents/${id}/turn`, { text: 'from bob' });
    await stateOf(id, 'idle', mark);
    items = (await api.get(`/api/agents/${id}/items`)).body.items.map(
      (i: any) => i.item,
    );
    expect(
      items
        .filter((i: any) => i.kind === 'user')
        .map((i: any) => `${i.by}:${i.text}`),
    ).toEqual(['admin:from admin', 'bob:from bob']);
    daemon.removeAllListeners('input');
  });
});

describe('transcript cache', () => {
  const turn = async (id: string, text: string) => {
    const mark = events.mark();
    await api.post(`/api/agents/${id}/turn`, { text });
    await stateOf(id, 'idle', mark);
  };
  const itemsOf = async (id: string, query = '') =>
    (await api.get(`/api/agents/${id}/items${query}`)).body as {
      items: any[];
      total: number;
    };

  it('a restart continues from the cache: only the log past the last turn end is replayed', async () => {
    scriptCodex(daemon);
    const id = await newAgent('c1');
    const sid = await sessionOf(id);
    for (const t of ['one', 'two', 'three']) await turn(id, t);
    const before = await itemsOf(id);
    expect(before.total).toBe(before.items.length);
    expect(before.items.map((i) => i.index)).toEqual(
      before.items.map((_, k) => k),
    );
    expect(before.items.filter((i) => i.item.kind === 'turn_end')).toHaveLength(
      3,
    );
    const settledSeq = daemon.sessions.get(sid)!.record.lastSeq;
    await sleep(200); // the cache write
    daemon.attaches.length = 0;
    await restartManager();
    await untilState(id, 'idle');
    expect(daemon.attaches.filter((a) => a.sessionId === sid)).toEqual([
      { sessionId: sid, fromSeq: settledSeq + 1 },
    ]);
    expect(methods(sid).filter((x) => x === 'initialize')).toHaveLength(1);
    expect(await itemsOf(id)).toEqual(before);
    await turn(id, 'four');
    const more = await itemsOf(id, `?from=${before.total}`);
    expect(more.items.map((i) => i.item.kind)).toEqual([
      'user',
      'text',
      'turn_end',
    ]);
    expect(more.items[0].item.by).toBe('admin');
    expect(more.total).toBe(before.total + 3);
    daemon.removeAllListeners('input');
  }, 30000);

  it('a restart mid-turn replays from the last turn end; the turn then finishes without duplicates', async () => {
    scriptCodex(daemon);
    const id = await newAgent('c2');
    const sid = await sessionOf(id);
    await turn(id, 'one');
    await sleep(200);
    const settledSeq = daemon.sessions.get(sid)!.record.lastSeq;
    daemon.removeAllListeners('input');
    scriptCodex(daemon, { holdTurn: true });
    let mark = events.mark();
    await api.post(`/api/agents/${id}/turn`, { text: 'two' });
    await stateOf(id, 'working', mark);
    await sleep(200);
    daemon.attaches.length = 0;
    await restartManager();
    await untilState(id, 'working');
    expect(daemon.attaches.filter((a) => a.sessionId === sid)).toEqual([
      { sessionId: sid, fromSeq: settledSeq + 1 },
    ]);
    mark = events.mark();
    finishTurn(daemon, sid);
    await stateOf(id, 'idle', mark);
    const { items, total } = await itemsOf(id);
    expect(total).toBe(items.length);
    expect(items.map((i) => i.item.kind)).toEqual([
      'system',
      'user',
      'text',
      'turn_end',
      'user',
      'text',
      'turn_end',
    ]);
    expect(items.map((i) => i.item.by ?? '')).toContain('admin');
    daemon.removeAllListeners('input');
  }, 30000);

  it('pages backwards with stable indexes across the cache and the resident tail', async () => {
    scriptCodex(daemon);
    const id = await newAgent('c3');
    for (const t of ['one', 'two', 'three', 'four']) await turn(id, t);
    await sleep(200);
    const all = await itemsOf(id);
    expect(all.total).toBe(13); // started + 4 * (user, text, turn_end)
    const tail = await itemsOf(id, '?tail=2');
    expect(tail).toEqual({ items: all.items.slice(-2), total: 13 });
    const page = await itemsOf(id, `?before=${tail.items[0].index}&limit=3`);
    expect(page).toEqual({ items: all.items.slice(8, 11), total: 13 });
    expect(await itemsOf(id, '?before=2&limit=5')).toEqual({
      items: all.items.slice(0, 2),
      total: 13,
    });
    expect(await itemsOf(id, '?before=0&limit=5')).toEqual({
      items: [],
      total: 13,
    });
    expect(await itemsOf(id, '?from=11')).toEqual({
      items: all.items.slice(11),
      total: 13,
    });
    expect(await itemsOf(id, '?tail=100')).toEqual(all);
    for (const bad of ['?tail=x', '?before=-1', '?limit=1.5'])
      expect((await api.get(`/api/agents/${id}/items${bad}`)).status).toBe(400);
    daemon.removeAllListeners('input');
  }, 30000);

  it('an archived agent is left alone at start and loaded on the first request', async () => {
    scriptCodex(daemon);
    const id = await newAgent('c4');
    const sid = await sessionOf(id);
    await turn(id, 'one');
    await turn(id, 'two');
    expect((await api.post(`/api/agents/${id}/archive`)).status).toBe(201);
    await sleep(300);
    const before = await itemsOf(id);
    expect(before.items.map((i) => i.item.kind).slice(-2)).toEqual([
      'turn_end',
      'system',
    ]);
    daemon.attaches.length = 0;
    await restartManager();
    await sleep(300);
    expect(daemon.attaches.filter((a) => a.sessionId === sid)).toEqual([]);
    expect(await itemsOf(id)).toEqual(before);
    // the ended session was fully cached: consulted, nothing replayed
    expect(daemon.attaches.filter((a) => a.sessionId === sid)).toEqual([
      { sessionId: sid, fromSeq: daemon.sessions.get(sid)!.record.lastSeq + 1 },
    ]);
    daemon.removeAllListeners('input');
  }, 30000);

  it('an earlier session whose replay failed does not end up cached out of order', async () => {
    scriptCodex(daemon);
    const id = await newAgent('c6');
    const s1 = await sessionOf(id);
    await turn(id, 'one');
    let mark = events.mark();
    await api.post(`/api/agents/${id}/stop`);
    await stateOf(id, 'exited', mark);
    mark = events.mark();
    await api.post(`/api/agents/${id}/turn`, { text: 'two' }); // resumes: a second session
    await stateOf(id, 'idle', mark);
    const s2 = await sessionOf(id);
    expect(s2).not.toBe(s1);
    await sleep(200);
    const good = await itemsOf(id);
    const kinds = (r: { items: any[] }) => r.items.map((i) => i.item.kind);
    expect(kinds(good)).toEqual([
      'system',
      'user',
      'text',
      'turn_end',
      'system', // session one, ended
      'system',
      'user',
      'text',
      'turn_end', // session two
    ]);
    // restart with the first session's log unreadable, then again with it back
    fs.rmSync(path.join(m.dataDir, 'transcripts'), {
      recursive: true,
      force: true,
    });
    daemon.onAttach = (sid) => (sid === s1 ? 'refuse' : 'ok');
    await restartManager();
    await untilState(id, 'idle');
    await turn(id, 'three'); // history after the gap, settled and cached
    await sleep(200);
    const degraded = await itemsOf(id);
    expect(
      degraded.items.some((i) => /history unavailable/.test(i.item.text ?? '')),
    ).toBe(true);
    daemon.onAttach = null;
    await restartManager();
    await untilState(id, 'idle');
    await sleep(300);
    const recovered = await itemsOf(id);
    expect(kinds(recovered)).toEqual([
      ...kinds(good),
      'user',
      'text',
      'turn_end',
    ]);
    expect(recovered.items.map((i) => i.index)).toEqual(
      recovered.items.map((_, k) => k),
    );
    expect(recovered.items.map((i) => i.sessionId)).toEqual([
      ...Array(5).fill(s1),
      ...Array(7).fill(s2),
    ]);
    daemon.removeAllListeners('input');
  }, 40000);

  it('an archived agent whose replay failed is tried again once the daemon reconnects', async () => {
    scriptCodex(daemon);
    const id = await newAgent('c7');
    const sid = await sessionOf(id);
    await turn(id, 'one');
    expect((await api.post(`/api/agents/${id}/archive`)).status).toBe(201);
    await sleep(300);
    const before = await itemsOf(id);
    fs.rmSync(path.join(m.dataDir, 'transcripts'), {
      recursive: true,
      force: true,
    });
    daemon.onAttach = () => 'refuse';
    await restartManager();
    const failed = await itemsOf(id);
    expect(
      failed.items.some((i) => /history unavailable/.test(i.item.text ?? '')),
    ).toBe(true);
    daemon.onAttach = null;
    expect(await itemsOf(id)).toEqual(failed); // same connection: served as is, no new attempt
    daemon.cut();
    await sleep(1500);
    const again = await itemsOf(id);
    // the "history unavailable" note stays as a marker; the history follows it
    const turns = (r: { items: any[] }) =>
      r.items.map((i) => i.item.kind).filter((k) => k !== 'system');
    expect(turns(again)).toEqual(turns(before));
    expect(again.items[again.items.length - 1].item.text).toMatch(
      /^session ended/,
    );
    expect(
      daemon.attaches.filter((a) => a.sessionId === sid).length,
    ).toBeGreaterThanOrEqual(2);
    daemon.removeAllListeners('input');
  }, 30000);

  it('an archived agent with a session that cannot be replayed is retried once per connection, not per request', async () => {
    scriptCodex(daemon);
    const id = await newAgent('c8');
    const s1 = await sessionOf(id);
    await turn(id, 'one');
    let mark = events.mark();
    await api.post(`/api/agents/${id}/stop`);
    await stateOf(id, 'exited', mark);
    mark = events.mark();
    await api.post(`/api/agents/${id}/turn`, { text: 'two' });
    await stateOf(id, 'idle', mark);
    const s2 = await sessionOf(id);
    expect((await api.post(`/api/agents/${id}/archive`)).status).toBe(201);
    await sleep(300);
    fs.rmSync(path.join(m.dataDir, 'transcripts'), {
      recursive: true,
      force: true,
    });
    daemon.onAttach = (sid) => (sid === s1 ? 'refuse' : 'ok');
    await restartManager();
    daemon.attaches.length = 0;
    const mine = () =>
      daemon.attaches
        .map((a) => a.sessionId)
        .filter((sid) => sid === s1 || sid === s2);
    for (let i = 0; i < 4; i++) await itemsOf(id);
    // one attempt: session one refused, session two replayed, then served as is
    expect(mine()).toEqual([s1, s2]);
    // the daemon comes back (a new connection): one more attempt, complete
    daemon.onAttach = null;
    daemon.attaches.length = 0;
    daemon.cut();
    await sleep(1500);
    const { items } = await itemsOf(id);
    expect(mine()).toEqual([s1, s2]);
    expect(items.map((i) => i.sessionId)).toEqual([
      ...Array(5).fill(s1),
      ...Array(5).fill(s2),
    ]);
    daemon.removeAllListeners('input');
  }, 40000);

  it('a corrupt cache line rebuilds that agent and leaves the others alone', async () => {
    scriptCodex(daemon);
    const a = await newAgent('c9');
    const b = await newAgent('c10');
    await turn(a, 'one');
    await turn(b, 'one');
    await sleep(300);
    const before = await itemsOf(a);
    const file = path.join(m.dataDir, 'transcripts', `${a}.ndjson`);
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    const bad = lines[lines.length - 2]!;
    lines[lines.length - 2] = bad.slice(0, -6) + 'xxxxxx'; // same length: the header still matches
    fs.writeFileSync(file, lines.join('\n'));
    await restartManager();
    await untilState(a, 'idle');
    await untilState(b, 'idle');
    // identical but for the boundary item's time, which is when it was written
    const sansAt = (r: { items: any[] }) =>
      r.items.map((i) => ({ ...i, at: 0 }));
    expect(sansAt(await itemsOf(a))).toEqual(sansAt(before));
    expect((await itemsOf(b)).items.map((i) => i.item.kind)).toContain(
      'turn_end',
    );
    await turn(b, 'two'); // the agent after the corrupt one is fully usable
    daemon.removeAllListeners('input');
  }, 40000);

  it('a cache the log contradicts is rebuilt from the log', async () => {
    scriptCodex(daemon);
    const id = await newAgent('c5');
    const sid = await sessionOf(id);
    await turn(id, 'one');
    await sleep(200);
    const before = await itemsOf(id);
    await events.close();
    await m.stop();
    // the daemon forgot the tail of the log (a daemon reinstalled from a backup, say)
    const session = daemon.sessions.get(sid)!;
    session.log.splice(-2);
    session.record.lastSeq = session.log[session.log.length - 1]!.seq;
    m = await startManager(daemon.url, m.dataDir, managerOverrides);
    api = new Api(m.url);
    await api.login();
    events = await Events.connect(m.url, api.cookie);
    await sleep(500);
    const after = await itemsOf(id);
    expect(after.items.map((i) => i.index)).toEqual(
      after.items.map((_, k) => k),
    );
    expect(after.total).toBe(before.total - 2);
    expect(daemon.attaches.filter((a) => a.sessionId === sid).pop()).toEqual({
      sessionId: sid,
      fromSeq: 1,
    });
    daemon.removeAllListeners('input');
  }, 30000);
});
