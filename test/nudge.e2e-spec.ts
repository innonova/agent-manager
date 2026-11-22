import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDaemon, startManager, Api, sleep } from './helpers.js';
import type { TestDaemon, TestManager } from './helpers.js';

/**
 * Asking an agent that stopped whether it can go on: for an agent
 * with it turned on, the manager reads the last message when a turn
 * ends (here a script reads it), and after a short wait asks the
 * agent, unless the agent needs a person or is done, a person says
 * something first, or it was asked already and has not worked since.
 */
let daemon: TestDaemon;
let m: TestManager;
let api: Api;
let project: { id: string };
let read: string;

async function until<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  ms = 10_000,
): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}
const itemsOf = async (id: string) =>
  (await api.get(`/api/agents/${id}/items`)).body.items.map(
    (i: any) => i.item,
  ) as any[];
const statusOf = async (id: string) =>
  (await api.get(`/api/agents/${id}`)).body.status;
const system = async (id: string) =>
  (await itemsOf(id)).filter((i) => i.kind === 'system').map((i) => i.text);
const nudges = async (id: string) =>
  (await itemsOf(id)).filter(
    (i) =>
      i.kind === 'user' &&
      i.by === 'manager' &&
      i.text.startsWith('The manager, not a person:'),
  ).length;
const readings = () =>
  fs.existsSync(read)
    ? fs.readFileSync(read, 'utf8').split('\n').filter(Boolean).length
    : 0;

async function agent(name: string, nudge: boolean): Promise<string> {
  const a = (await api.post(`/api/projects/${project.id}/agents`, { name }))
    .body.agent as { id: string };
  if (nudge)
    expect(
      (await api.patch(`/api/agents/${a.id}`, { nudge: true })).body.agent
        .nudge,
    ).toBe(true);
  return a.id;
}
/** A turn, waited for until its reply is there and the agent is idle again. */
async function turn(id: string, text: string): Promise<void> {
  await api.post(`/api/agents/${id}/turn`, { text });
  await until('the reply', async () =>
    (await itemsOf(id)).some(
      (i) => i.kind === 'text' && i.text.includes(`You said: ${text}`),
    ),
  );
  await until('idle', async () => (await statusOf(id)).state === 'idle');
}

beforeAll(async () => {
  daemon = await startDaemon();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-nudge-'));
  read = path.join(dir, 'readings.txt');
  // A reader that goes by a word in the agent's last message, which echoes the person's.
  const script = path.join(dir, 'reader.mjs');
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const said = input.slice(input.lastIndexOf('<agent>'));
  fs.appendFileSync(${JSON.stringify(read)}, said.replace(/\\n/g, ' ') + '\\n');
  const verdict = said.includes('BLOCKED') ? 'needs_person' : said.includes('FINISHED') ? 'done' : 'paused';
  console.log(JSON.stringify({ verdict, why: verdict === 'paused' ? 'the doors are next' : verdict === 'done' ? 'all maps converted' : 'which site to keep' }));
});
`,
  );
  m = await startManager(daemon.url, undefined, {
    nudgeReader: [process.execPath, script],
    nudgeDelayMs: 600,
  });
  api = new Api(m.url);
  await api.login();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'am-nudge-repo-'));
  project = (
    await api.post('/api/projects', {
      name: 'tireless',
      path: repo,
      defaultProfile: 'fake',
    })
  ).body.project;
}, 30000);

afterAll(async () => {
  await m?.stop();
  await daemon?.stop();
});

describe('asking an agent that stopped whether it can go on', () => {
  it('is off unless turned on: no model reads the last message of an agent nobody asked it for', async () => {
    const id = await agent('quiet', false);
    const before = readings();
    await turn(id, 'one');
    await sleep(400);
    expect(readings()).toBe(before);
    expect((await statusOf(id)).nudge).toBeNull();
    expect(
      (await api.patch(`/api/agents/${id}`, { nudge: 'yes' })).status,
    ).toBe(400);
  });

  it('asks after a short wait, says so meanwhile, and does not ask again when the answer was short', async () => {
    const id = await agent('keeper', true);
    await turn(id, 'convert the maps');
    // read, then waiting: the status says when the question goes, and the flow says why
    const waiting = await until('the wait', async () => {
      const n = (await statusOf(id)).nudge;
      return n?.state === 'waiting' ? n : null;
    });
    expect(waiting.at).toBeGreaterThan(Date.now() - 1000);
    expect((await system(id)).pop()).toMatch(
      /^stopped with work left \(the doors are next\); the manager asks it at \d\d:\d\d whether it can go on, unless a person says something first$/,
    );
    expect(await nudges(id)).toBe(0);
    // the question, in the manager's name, as a turn
    await until('the nudge', async () => (await nudges(id)) === 1);
    expect((await statusOf(id)).nudge).toBeNull();
    // the fake agent answers it in an instant: asked once, and then left alone
    await until('the second reading', async () =>
      (await system(id)).some((t) =>
        t.includes('not asked whether it can go on'),
      ),
    );
    expect((await system(id)).pop()).toBe(
      'stopped with work left (the doors are next); not asked whether it can go on: it has worked 0 min since it was last asked',
    );
    await sleep(900);
    expect(await nudges(id)).toBe(1);
    // a person writes: the next stop can be asked about again
    await turn(id, 'and the doors');
    await until(
      'the nudge after a person wrote',
      async () => (await nudges(id)) === 2,
    );
  }, 30000);

  it('pages the person and asks nothing when the agent needs them; leaves an agent alone that says it is done', async () => {
    const id = await agent('asker', true);
    await turn(id, 'BLOCKED on the site');
    await until('the verdict', async () =>
      (await system(id)).some((t) =>
        t.startsWith('stopped, and needs a person'),
      ),
    );
    expect((await system(id)).pop()).toBe(
      'stopped, and needs a person: which site to keep; paged',
    );
    await turn(id, 'FINISHED now');
    await until('the verdict', async () =>
      (await system(id)).some((t) =>
        t.startsWith('stopped: it says the work is done'),
      ),
    );
    await sleep(900);
    expect(await nudges(id)).toBe(0);
    expect((await statusOf(id)).nudge).toBeNull();
  }, 30000);

  it('is called off by a person: the button on the notice, a message, or stopping the turn', async () => {
    const id = await agent('held', true);
    await turn(id, 'first');
    await until(
      'the wait',
      async () => (await statusOf(id)).nudge?.state === 'waiting',
    );
    expect((await api.post(`/api/agents/${id}/nudge/hold`)).body).toEqual({
      ok: true,
      held: true,
    });
    expect((await statusOf(id)).nudge).toBeNull();
    expect((await system(id)).pop()).toBe(
      'not asked whether it can go on: admin called it off',
    );
    expect((await api.post(`/api/agents/${id}/nudge/hold`)).body.held).toBe(
      false,
    );
    await sleep(900);
    expect(await nudges(id)).toBe(0);

    // a message while it waits: theirs is the next turn, the question is dropped
    await turn(id, 'second');
    await until(
      'the wait',
      async () => (await statusOf(id)).nudge?.state === 'waiting',
    );
    await api.post(`/api/agents/${id}/turn`, { text: 'linger' });
    await until(
      'working',
      async () => (await statusOf(id)).state === 'working',
    );
    expect((await statusOf(id)).nudge).toBeNull();
    // and a turn the person stopped is not read at all
    const before = readings();
    await api.post(`/api/agents/${id}/interrupt`);
    await until('idle', async () => (await statusOf(id)).state === 'idle');
    await sleep(900);
    expect(readings()).toBe(before);
    expect(await nudges(id)).toBe(0);
  }, 30000);
});
