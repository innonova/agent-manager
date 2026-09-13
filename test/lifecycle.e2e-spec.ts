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
  opts: { approvalOnTurn?: boolean; failInterrupt?: boolean } = {},
) {
  d.on('input', (sid, line: any) => {
    if (line?.method === 'initialize')
      d.out(sid, {
        jsonrpc: '2.0',
        id: line.id,
        result: { userAgent: 'scripted' },
      });
    if (line?.method === 'thread/start') {
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
      else finishTurn(d, sid);
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

async function restartManager() {
  await events.close();
  await m.stop();
  m = await startManager(daemon.url, m.dataDir);
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
  m = await startManager(daemon.url);
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
