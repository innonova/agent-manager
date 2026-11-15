import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { startDaemon, startManager, Api, Events, sleep } from './helpers.js';
import type { TestDaemon, TestManager } from './helpers.js';

/**
 * The chat between people and one agent: a record beside the transcript
 * that neither side stops for. A message to a working agent waits
 * unread while the agent is told it exists; one to an idle agent starts
 * a turn; what is unread when a turn ends is handed over. The agent
 * writes messages, decisions and questions with its own token.
 */
let daemon: TestDaemon;
let m: TestManager;
let api: Api;
let events: Events;
let project: { id: string };

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
const userTexts = async (id: string) =>
  (await itemsOf(id))
    .filter((i) => i.kind === 'user')
    .map((i) => i.text as string);
const stateOf = async (id: string) =>
  (await api.get(`/api/agents/${id}`)).body.status.state as string;
const chatOf = async (id: string) =>
  (await api.get(`/api/agents/${id}/chat`)).body as {
    messages: any[];
    summary: { unread: number; questions: number; last: number };
  };

/** A fake agent, idle, with the token its `am` would use. */
async function newAgent(name: string): Promise<{ id: string; own: Api }> {
  const agent = (await api.post(`/api/projects/${project.id}/agents`, { name }))
    .body.agent as { id: string };
  await api.post(`/api/agents/${agent.id}/turn`, { text: 'token please' });
  const token = await until('the agent to say its token', async () => {
    const said = (await itemsOf(agent.id))
      .filter((i) => i.kind === 'text')
      .map((i) => i.text)
      .join('\n');
    return /token ([0-9a-f]{64})/.exec(said)?.[1];
  });
  await until(
    'the first turn to end',
    async () => (await stateOf(agent.id)) === 'idle',
  );
  const own = new Api(m.url);
  own.bearer = token;
  // its token says which agent it is, so its `am` need not be told
  expect((await own.get('/api/auth/me')).body.agent).toEqual({
    id: agent.id,
    projectId: project.id,
  });
  return { id: agent.id, own };
}

/** Starts a turn that stays working until interrupted. */
async function linger(id: string): Promise<void> {
  await api.post(`/api/agents/${id}/turn`, { text: 'linger' });
  await until(
    'the agent to work',
    async () => (await stateOf(id)) === 'working',
  );
}

beforeAll(async () => {
  daemon = await startDaemon();
  m = await startManager(daemon.url, undefined, {
    chatRepeatMs: 1500,
    chatSweepMs: 400,
  });
  api = new Api(m.url);
  await api.login();
  events = await Events.connect(m.url, api.cookie);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'am-chat-'));
  project = (
    await api.post('/api/projects', {
      name: 'chatty',
      path: repo,
      defaultProfile: 'fake',
    })
  ).body.project;
}, 30000);

afterAll(async () => {
  await events?.close();
  await m?.stop();
  await daemon?.stop();
});

describe('chat', () => {
  it('a message to an idle agent starts a turn and is read at once', async () => {
    const a = await newAgent('idle-one');
    const mark = events.mark();
    const said = await api.post(`/api/agents/${a.id}/chat`, {
      text: 'the header is misaligned on the files page',
    });
    expect(said.status).toBe(201);
    expect(said.body.mode).toBe('turn');
    expect(said.body.message).toMatchObject({
      from: 'person',
      author: 'admin',
      kind: 'message',
      via: 'turn',
      text: 'the header is misaligned on the files page',
    });
    expect(said.body.message.readAt).toBeGreaterThan(0);
    // the turn carries the text as it was written
    await until('the turn', async () =>
      (await userTexts(a.id)).includes(
        'the header is misaligned on the files page',
      ),
    );
    await events.waitFor(
      (f) =>
        f.type === 'chat.changed' &&
        f.agentId === a.id &&
        f.projectId === project.id &&
        f.messages[0]?.id === said.body.message.id &&
        f.summary.unread === 0,
      5000,
      mark,
    );
    // the turn the test sent to get the token went through the turn route: it is in the chat too
    const chat = await chatOf(a.id);
    expect(chat.messages.map((x) => [x.text, x.via])).toEqual([
      ['token please', 'turn'],
      ['the header is misaligned on the files page', 'turn'],
    ]);
    expect(chat.summary).toMatchObject({ unread: 0, questions: 0 });
  });

  it('a message to a working agent without a hook waits unread, and the agent is told by a one-line steer of the manager’s', async () => {
    const a = await newAgent('no-hook');
    await linger(a.id);
    const said = await api.post(`/api/agents/${a.id}/chat`, {
      text: 'use the darker grey there',
    });
    expect(said.body.mode).toBe('aside');
    expect(said.body.message).toMatchObject({ via: 'aside', readAt: null });
    expect((await chatOf(a.id)).summary.unread).toBe(1);
    // told that it exists, not what it says, and not as the person
    const notice = await until('the notice', async () =>
      (await itemsOf(a.id)).find(
        (i) => i.kind === 'user' && i.text.startsWith('Chat: 1 unread message'),
      ),
    );
    expect(notice.text).toContain('from admin');
    expect(notice.text).toContain('`am chat`');
    expect(notice.text).not.toContain('darker grey');
    expect(notice.by).toBe('manager');
    expect(await stateOf(a.id)).toBe('working'); // nothing was interrupted
    // a person's fetch is not a reading
    expect((await api.post(`/api/agents/${a.id}/chat/read`)).status).toBe(403);
    expect((await chatOf(a.id)).summary.unread).toBe(1);
    // the agent reads: the text, and the mark
    const mark = events.mark();
    const read = await a.own.post(`/api/agents/${a.id}/chat/read`);
    expect(read.status).toBe(200);
    expect(read.body.messages).toHaveLength(1);
    expect(read.body.messages[0]).toMatchObject({
      id: said.body.message.id,
      text: 'use the darker grey there',
      author: 'admin',
    });
    expect(read.body.messages[0].readAt).toBeGreaterThan(0);
    expect(read.body.summary.unread).toBe(0);
    await events.waitFor(
      (f) =>
        f.type === 'chat.changed' &&
        f.agentId === a.id &&
        f.messages[0]?.readAt > 0,
      5000,
      mark,
    );
    // nothing left to read, and nothing delivered when the turn ends
    expect(
      (await a.own.post(`/api/agents/${a.id}/chat/read`)).body.messages,
    ).toEqual([]);
    await api.post(`/api/agents/${a.id}/interrupt`);
    await until('idle', async () => (await stateOf(a.id)) === 'idle');
    await sleep(900); // two sweeps
    expect(
      (await userTexts(a.id)).filter((t) => t.includes('darker grey')),
    ).toEqual([]);
  });

  it('an agent with a hook is told when it asks: at once for a new message, again after a while, never by a steer', async () => {
    const a = await newAgent('hooked');
    // nobody but an agent has a chat to ask about
    expect((await api.post('/api/chat/notice')).status).toBe(403);
    // its hook asks after a tool call: nothing unread, and the session is known to have a hook
    expect((await a.own.post('/api/chat/notice')).body).toEqual({
      text: null,
    });
    await linger(a.id);
    await api.post(`/api/agents/${a.id}/chat`, { text: 'first thought' });
    const one = (await a.own.post('/api/chat/notice')).body.text as string;
    expect(one).toMatch(
      /^Chat: 1 unread message from admin, written just now\./,
    );
    expect(one).not.toContain('first thought');
    // told once; asking again right away says nothing
    expect((await a.own.post('/api/chat/notice')).body.text).toBeNull();
    // a new message is news
    await api.post(`/api/agents/${a.id}/chat`, { text: 'second thought' });
    expect((await a.own.post('/api/chat/notice')).body.text).toMatch(
      /^Chat: 2 unread messages from admin, the oldest written just now\./,
    );
    expect((await a.own.post('/api/chat/notice')).body.text).toBeNull();
    // still unread after the repeat interval: said again
    await sleep(1600);
    expect((await a.own.post('/api/chat/notice')).body.text).toMatch(
      /^Chat: 2 unread messages/,
    );
    // no steer went to it: the hook is how it hears
    expect(
      (await userTexts(a.id)).filter((t) => t.startsWith('Chat:')),
    ).toEqual([]);
    // read, and the notice goes quiet
    const read = await a.own.post(`/api/agents/${a.id}/chat/read`);
    expect(read.body.messages.map((x: any) => x.text)).toEqual([
      'first thought',
      'second thought',
    ]);
    expect((await a.own.post('/api/chat/notice')).body.text).toBeNull();
    await api.post(`/api/agents/${a.id}/interrupt`);
    await until('idle', async () => (await stateOf(a.id)) === 'idle');
  });

  it('what is unread when the turn ends is handed over as one turn', async () => {
    const a = await newAgent('turn-end');
    await a.own.post('/api/chat/notice'); // a hook: no steer in the way
    await linger(a.id);
    await api.post(`/api/agents/${a.id}/chat`, { text: 'one more thing' });
    await api.post(`/api/agents/${a.id}/chat`, { text: 'and another' });
    expect((await chatOf(a.id)).summary.unread).toBe(2);
    await api.post(`/api/agents/${a.id}/interrupt`);
    const turn = await until('the delivery', async () =>
      (await userTexts(a.id)).find((t) => t.includes('one more thing')),
    );
    expect(turn).toMatch(/^2 chat messages, written while you worked:\n\n/);
    expect(turn).toMatch(
      /admin, \d\d:\d\d:\none more thing\n\nadmin, \d\d:\d\d:\nand another$/,
    );
    const chat = await until('both read', async () => {
      const c = await chatOf(a.id);
      return c.summary.unread === 0 && c;
    });
    expect(chat.messages.slice(-2).map((x) => [x.via, x.readAt > 0])).toEqual([
      ['aside', true],
      ['aside', true],
    ]);
    // once: no second delivery from the sweep
    await until('idle', async () => (await stateOf(a.id)) === 'idle');
    await sleep(900);
    expect(
      (await userTexts(a.id)).filter((t) => t.includes('one more thing')),
    ).toHaveLength(1);
  });

  it('a single unread message at the turn’s end arrives as it was written, by its author', async () => {
    const a = await newAgent('turn-end-one');
    await a.own.post('/api/chat/notice');
    await linger(a.id);
    await api.post(`/api/agents/${a.id}/chat`, { text: 'just this' });
    await api.post(`/api/agents/${a.id}/interrupt`);
    const item = await until('the delivery', async () =>
      (await itemsOf(a.id)).find(
        (i) => i.kind === 'user' && i.text === 'just this',
      ),
    );
    expect(item.by).toBe('admin');
    await until('idle', async () => (await stateOf(a.id)) === 'idle');
  });

  it('the agent says a message, a decision and a question; a reply answers the question', async () => {
    const a = await newAgent('speaker');
    const mark = events.mark();
    const msg = await a.own.post(`/api/agents/${a.id}/chat`, {
      text: 'The store and the API are in; starting on the hook.',
    });
    expect(msg.status).toBe(201);
    expect(msg.body.message).toMatchObject({
      from: 'agent',
      author: 'speaker',
      kind: 'message',
      important: false,
      via: null,
    });
    const decision = await a.own.post(`/api/agents/${a.id}/chat`, {
      text: 'Kept the chat in SQLite rather than files.',
      kind: 'decision',
      important: true,
    });
    expect(decision.body.message).toMatchObject({
      kind: 'decision',
      important: true,
    });
    const question = await a.own.post(`/api/agents/${a.id}/chat`, {
      text: 'Should a steer be recorded in the chat as well?',
      kind: 'question',
    });
    const q = question.body.message;
    expect(q).toMatchObject({ kind: 'question', closedAt: null });
    await events.waitFor(
      (f) =>
        f.type === 'chat.changed' &&
        f.agentId === a.id &&
        f.summary.questions === 1,
      5000,
      mark,
    );
    expect(
      (await api.get(`/api/projects/${project.id}/chat`)).body,
    ).toContainEqual({ agentId: a.id, unread: 0, questions: 1, last: q.id });
    // the agent is not stopped by its question, and nothing became a turn
    expect(await userTexts(a.id)).toEqual(['token please']);
    // bad input
    expect(
      (
        await a.own.post(`/api/agents/${a.id}/chat`, {
          text: 'x',
          kind: 'shout',
        })
      ).status,
    ).toBe(400);
    expect((await a.own.post(`/api/agents/${a.id}/chat`, {})).status).toBe(400);
    expect(
      (
        await api.post(`/api/agents/${a.id}/chat`, {
          text: 'x',
          replyTo: 999999,
        })
      ).status,
    ).toBe(404);

    // the answer: a reply to the question closes it, and reaches the agent announced as the answer
    const answer = await api.post(`/api/agents/${a.id}/chat`, {
      text: 'Yes, everything I say to it.',
      replyTo: q.id,
    });
    expect(answer.body.mode).toBe('turn'); // the agent was idle
    expect(answer.body.message.re).toEqual({
      id: q.id,
      kind: 'question',
      excerpt: 'Should a steer be recorded in the chat as well?',
    });
    const turn = await until('the answer as a turn', async () =>
      (await userTexts(a.id)).find((t) => t.includes('everything I say')),
    );
    expect(turn).toBe(
      `Answer to your question #${q.id} ("Should a steer be recorded in the chat as well?"):\n\nYes, everything I say to it.`,
    );
    const chat = await chatOf(a.id);
    expect(chat.summary.questions).toBe(0);
    expect(chat.messages.find((x) => x.id === q.id)).toMatchObject({
      closedBy: 'answer',
    });
    await until('idle', async () => (await stateOf(a.id)) === 'idle');

    // a question nobody answers: the agent closes it, or a person dismisses it
    const q2 = (
      await a.own.post(`/api/agents/${a.id}/chat`, {
        text: 'Blue or green?',
        kind: 'question',
      })
    ).body.message;
    const closed = await a.own.post(`/api/agents/${a.id}/chat/${q2.id}/close`);
    expect(closed.status).toBe(200);
    expect(closed.body.message).toMatchObject({ closedBy: 'agent' });
    const q3 = (
      await a.own.post(`/api/agents/${a.id}/chat`, {
        text: 'Tabs or spaces?',
        kind: 'question',
      })
    ).body.message;
    expect(
      (await api.post(`/api/agents/${a.id}/chat/${q3.id}/close`)).body.message,
    ).toMatchObject({ closedBy: 'person' });
    expect((await chatOf(a.id)).summary.questions).toBe(0);
    // only a question can be closed
    expect(
      (await api.post(`/api/agents/${a.id}/chat/${msg.body.message.id}/close`))
        .status,
    ).toBe(400);
  });

  it('a steer from the chat goes into the running turn and is in the chat as a steer', async () => {
    const a = await newAgent('steered');
    await linger(a.id);
    const said = await api.post(`/api/agents/${a.id}/chat`, {
      text: 'stop, the other file',
      steer: true,
    });
    expect(said.body.mode).toBe('steer');
    expect(said.body.message).toMatchObject({ via: 'steer' });
    expect(said.body.message.readAt).toBeGreaterThan(0);
    await until('the steer in the transcript', async () =>
      (await itemsOf(a.id)).find(
        (i) =>
          i.kind === 'user' &&
          i.text === 'stop, the other file' &&
          i.by === 'admin',
      ),
    );
    expect((await chatOf(a.id)).summary.unread).toBe(0);
    await api.post(`/api/agents/${a.id}/interrupt`);
    await until('idle', async () => (await stateOf(a.id)) === 'idle');
  });

  it('a message the state change did not deliver is delivered by the sweep', async () => {
    const a = await newAgent('swept');
    // as after a restart of the manager: unread in the store, the agent idle, no event to act on
    const db = new Database(path.join(m.dataDir, 'manager.db'));
    db.prepare(
      "INSERT INTO chat_messages (agent_id, from_agent, author_id, author_name, text, via, created_at) VALUES (?, 0, NULL, 'admin', 'left over', 'aside', ?)",
    ).run(a.id, Date.now());
    db.close();
    await until('the delivery', async () =>
      (await userTexts(a.id)).includes('left over'),
    );
    expect((await chatOf(a.id)).summary.unread).toBe(0);
    await until('idle', async () => (await stateOf(a.id)) === 'idle');
  });

  it('pages back, refuses an archived agent, and goes with the agent', async () => {
    const a = await newAgent('paged');
    for (const text of ['m1', 'm2', 'm3'])
      await a.own.post(`/api/agents/${a.id}/chat`, { text });
    const last2 = (await api.get(`/api/agents/${a.id}/chat?limit=2`)).body
      .messages as any[];
    expect(last2.map((x) => x.text)).toEqual(['m2', 'm3']);
    const older = (
      await api.get(`/api/agents/${a.id}/chat?limit=2&before=${last2[0].id}`)
    ).body.messages as any[];
    expect(older.map((x) => x.text)).toEqual(['token please', 'm1']);
    expect((await api.get(`/api/agents/${a.id}/chat?limit=0`)).status).toBe(
      400,
    );
    // a question still open when the agent is archived closes with it
    await a.own.post(`/api/agents/${a.id}/chat`, {
      text: 'still there?',
      kind: 'question',
    });
    expect((await chatOf(a.id)).summary.questions).toBe(1);
    await api.post(`/api/agents/${a.id}/archive`);
    expect((await chatOf(a.id)).summary.questions).toBe(0);
    expect((await chatOf(a.id)).messages.at(-1)).toMatchObject({
      text: 'still there?',
      closedBy: 'agent',
    });
    expect(
      (await api.post(`/api/agents/${a.id}/chat`, { text: 'hello?' })).status,
    ).toBe(409);
    await api.delete(`/api/agents/${a.id}`);
    expect((await api.get(`/api/agents/${a.id}/chat`)).status).toBe(404);
    const db = new Database(path.join(m.dataDir, 'manager.db'));
    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE agent_id = ?')
        .get(a.id),
    ).toEqual({ n: 0 });
    db.close();
  });
});
