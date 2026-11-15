import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDaemon, startManager, Api, sleep } from './helpers.js';
import type { TestDaemon, TestManager } from './helpers.js';

/**
 * The dialog handed back after a compaction: the manager reads the
 * exchanges out of the transcript and the chat, a classifier (here a
 * script) weighs them, and the agent's hook is answered with a notice
 * naming the files the dialog was written to.
 */
let daemon: TestDaemon;
let m: TestManager;
let api: Api;
let project: { id: string };
let seen: string;

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
    await sleep(100);
  }
}
const itemsOf = async (id: string) =>
  (await api.get(`/api/agents/${id}/items`)).body.items.map(
    (i: any) => i.item,
  ) as any[];
const idle = (id: string) =>
  until(
    'the turn to end',
    async () =>
      (await api.get(`/api/agents/${id}`)).body.status.state === 'idle',
  );
async function turn(id: string, text: string): Promise<void> {
  await api.post(`/api/agents/${id}/turn`, { text });
  await until('the reply', async () =>
    (await itemsOf(id)).some(
      (i) => i.kind === 'text' && i.text.includes(`You said: ${text}`),
    ),
  );
  await idle(id);
}

beforeAll(async () => {
  daemon = await startDaemon();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-dialog-'));
  seen = path.join(dir, 'classifier-input.txt');
  // A classifier of two opinions: an exchange about the logo is a rule that
  // stands, one about the port was reversed by the next, the rest is chatter.
  const script = path.join(dir, 'classifier.mjs');
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(seen)}, input);
  console.log('Here are the lines.');
  for (const part of input.split('=== exchange ').slice(1)) {
    const id = Number(part.split(' ')[0]);
    if (part.includes('logo'))
      console.log(JSON.stringify({ id, kind: 'rule', in_force: true, weight: 3, superseded_by: null, line: 'The logo is teal, never blue.' }));
    else if (part.includes('port 1'))
      console.log(JSON.stringify({ id, kind: 'decision', in_force: true, weight: 3, superseded_by: id + 1, line: 'Port 1 chosen.' }));
    else console.log(JSON.stringify({ id, kind: 'chatter', in_force: false, weight: 0, superseded_by: null, line: 'nothing' }));
  }
});
`,
  );
  m = await startManager(daemon.url, undefined, {
    dialogClassifier: [process.execPath, script],
    dialogBudget: 0.001, // of the 200K assumed for an agent that reports no window: 200 tokens
    dialogWaitMs: 2000,
  });
  api = new Api(m.url);
  await api.login();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'am-dialog-repo-'));
  project = (
    await api.post('/api/projects', {
      name: 'talkative',
      path: repo,
      defaultProfile: 'fake',
    })
  ).body.project;
}, 30000);

afterAll(async () => {
  await m?.stop();
  await daemon?.stop();
});

describe('the dialog handed back after a compaction', () => {
  it('is read from the transcript, weighed by the classifier, and handed to the agent as files it is told to read', async () => {
    const agent = (
      await api.post(`/api/projects/${project.id}/agents`, { name: 'keeper' })
    ).body.agent as { id: string };
    // exchange 1 gives the test the agent's own token, as its hook would have it
    await api.post(`/api/agents/${agent.id}/turn`, { text: 'token please' });
    const token = await until('the agent to say its token', async () => {
      const said = (await itemsOf(agent.id))
        .filter((i) => i.kind === 'text')
        .map((i) => i.text)
        .join('\n');
      return /token ([0-9a-f]{64})/.exec(said)?.[1];
    });
    await idle(agent.id);
    const own = new Api(m.url);
    own.bearer = token;
    await turn(agent.id, 'the logo is teal, never blue');
    await turn(agent.id, 'use port 1');
    await turn(agent.id, 'no, port 2 after all');
    await turn(agent.id, 'thanks');
    await turn(agent.id, 'what is next?');
    // said beside the work: the chat is dialog too
    await own.post(`/api/agents/${agent.id}/chat`, {
      text: 'Next is the favicon.',
      kind: 'decision',
    });

    // the record, before anything weighed it: every exchange, numbered, by whom
    let list = (await api.get(`/api/agents/${agent.id}/dialog`)).body;
    expect(
      list.exchanges.map((e: any) => [e.n, e.by, e.line, e.weight]),
    ).toEqual([
      [1, 'admin', 'token please', null],
      [2, 'admin', 'the logo is teal, never blue', null],
      [3, 'admin', 'use port 1', null],
      [4, 'admin', 'no, port 2 after all', null],
      [5, 'admin', 'thanks', null],
      [6, 'admin', 'what is next?', null],
    ]);
    expect(list.weighed).toBeNull();
    const six = (await api.get(`/api/agents/${agent.id}/dialog/6`)).body
      .exchange;
    expect(six.person).toBe('what is next?');
    expect(six.agent).toContain('You said: what is next?');
    expect(six.agent).toContain(
      '[in the chat, a decision] Next is the favicon.',
    );
    expect((await api.get(`/api/agents/${agent.id}/dialog/7`)).status).toBe(
      404,
    );

    // weighed: one call with the whole dialog, both sides, and the instructions on top
    // started, not waited for: a real one takes minutes
    const started = await api.post(`/api/agents/${agent.id}/dialog/weigh`, {});
    expect(started.status).toBe(202);
    expect(started.body.weighing.model).toBe('node'); // the command's program, when it names no model
    await until('the weighing to end', async () => {
      const l = (await api.get(`/api/agents/${agent.id}/dialog`)).body;
      return l.weighing === null && l.weighed !== null;
    });
    const input = fs.readFileSync(seen, 'utf8');
    expect(input).toContain('output exactly one line of JSON');
    expect(input).toContain('=== exchange 2 (');
    expect(input).toContain('PERSON (admin):\nthe logo is teal, never blue');
    expect(input).toContain('AGENT:\nYou said: the logo is teal, never blue');
    list = (await api.get(`/api/agents/${agent.id}/dialog`)).body;
    expect(list.exchanges[1]).toMatchObject({
      n: 2,
      kind: 'rule',
      weight: 3,
      inForce: true,
      line: 'The logo is teal, never blue.',
    });
    expect(list.exchanges[2]).toMatchObject({
      inForce: false,
      supersededBy: 4,
    });
    expect(list.weighed).toMatchObject({ upTo: 6 });

    // what a hand-back would hold now, for a person to check: nothing written yet
    const preview = (await api.get(`/api/agents/${agent.id}/dialog/handback`))
      .body;
    expect(preview).toMatchObject({
      recent: [5, 6],
      kept: [2],
      indexed: 3,
      budget: 200,
    });
    expect(preview.files[0]).toContain('### #2 ·');
    expect(fs.existsSync(path.join(m.dataDir, 'handback'))).toBe(false);

    // the hook: only the agent itself has a dialog to ask for
    expect((await api.post('/api/dialog/handback')).status).toBe(403);
    const handed = await own.post('/api/dialog/handback');
    expect([handed.status, handed.body.message]).toEqual([200, undefined]);
    const { text } = handed.body as { text: string };
    const file = path.join(m.dataDir, 'handback', agent.id, 'dialog-1.md');
    expect(text).toContain(file);
    expect(text).toContain('Read this file in full');
    expect(text.length).toBeLessThan(10_000);
    const dialog = fs.readFileSync(file, 'utf8');
    // the last two whole, and of the older ones the rule that stands
    expect(dialog).toContain('### #6 ·');
    expect(dialog).toContain('### #5 ·');
    expect(dialog).toMatch(
      /### #2 · [^\n]+\nadmin:\nthe logo is teal, never blue\n\nYou:\nYou said: the logo is teal, never blue/,
    );
    // asked for by the agent in the middle of a window: the same files, said for what it is
    const asked = (await own.post('/api/dialog/handback', { on: 'request' }))
      .body.text as string;
    expect(asked).toContain('asked for now, without a compaction');
    expect(asked).toContain(file);
    // the reversed decision is a line that says so, and is not handed back as if it stood
    expect(dialog).not.toContain('### #3 ·');
    expect(dialog).toContain('decision: Port 1 chosen. (reversed by #4)');
    expect(dialog).toMatch(/#1: nothing to keep/);
    // in the order it happened: the index, the earlier one, then the recent
    expect(dialog.indexOf('### #2 ·')).toBeLessThan(dialog.indexOf('### #5 ·'));
    // and the flow says what the manager did
    const lines = (await itemsOf(agent.id))
      .filter((i) => i.kind === 'system')
      .map((i) => i.text as string);
    expect(lines.pop()).toMatch(/^dialog handed back on request: /);
    expect(lines.pop()).toMatch(
      /^dialog handed back: 3 exchanges word for word \(2 recent, 1 earlier\), 3 as index lines, about \d+ tokens; weighed by /,
    );
  }, 60000);
});
