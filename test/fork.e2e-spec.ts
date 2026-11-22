import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDaemon, startManager, Api, sleep } from './helpers.js';
import type { TestDaemon, TestManager } from './helpers.js';

/**
 * Forking an agent: a new one, in another project or stream, that
 * begins with the first one's whole conversation and its dialog with
 * the person, and is told that it is a copy. The fake agent keeps no
 * conversation on disk: the test plays the vendor, in a directory the
 * fake adapter is told of.
 */
let daemon: TestDaemon;
let m: TestManager;
let api: Api;
let vendor: string;
let origin: { id: string; path: string };

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
const agentOf = async (id: string) =>
  (await api.get(`/api/agents/${id}`)).body as {
    agent: {
      vendorConversationId: string | null;
      cwd: string;
      forkOf: string | null;
      forkConversation: string | null;
    };
    status: { state: string };
  };
const idle = (id: string) =>
  until(
    'the agent to be idle',
    async () => (await agentOf(id)).status.state === 'idle',
  );
async function turn(id: string, text: string): Promise<string> {
  const ends = async () =>
    (await itemsOf(id)).filter((i) => i.kind === 'turn_end').length;
  const before = await ends();
  await api.post(`/api/agents/${id}/turn`, { text });
  await until('the turn to end', async () => (await ends()) > before);
  await idle(id);
  const said = (await itemsOf(id))
    .filter((i) => i.kind === 'text')
    .map((i) => i.text as string);
  return said[said.length - 1]!.trim();
}
const system = async (id: string) =>
  (await itemsOf(id))
    .filter((i) => i.kind === 'system')
    .map((i) => i.text as string);

beforeAll(async () => {
  daemon = await startDaemon();
  vendor = fs.mkdtempSync(path.join(os.tmpdir(), 'am-fork-vendor-'));
  process.env.AGENT_MANAGER_FAKE_CONVERSATIONS = vendor;
  m = await startManager(daemon.url);
  api = new Api(m.url);
  await api.login();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'am-fork-origin-'));
  origin = (
    await api.post('/api/projects', {
      name: 'origin',
      path: repo,
      defaultProfile: 'fake',
    })
  ).body.project;
}, 30000);

afterAll(async () => {
  delete process.env.AGENT_MANAGER_FAKE_CONVERSATIONS;
  await m?.stop();
  await daemon?.stop();
});

describe('forking an agent', () => {
  it('makes a new agent in a stream that begins with the conversation, is told so once, and has the dialog as its own', async () => {
    const source = (
      await api.post(`/api/projects/${origin.id}/agents`, { name: 'elder' })
    ).body.agent as { id: string };
    await idle(source.id);

    // nothing to copy until it has been spoken to and the vendor has written the conversation down
    const early = await api.post(`/api/agents/${source.id}/fork`, {
      name: 'too-soon',
    });
    expect([early.status, early.body.message]).toEqual([
      409,
      'the agent has no conversation to copy yet: fork it once it has been spoken to',
    ]);
    await turn(source.id, 'the logo is teal, never blue');
    await turn(source.id, 'we ship on Fridays');
    const conversation = (await agentOf(source.id)).agent.vendorConversationId!;
    const theirs = path.join(
      vendor,
      path.basename(origin.path),
      `${conversation}.jsonl`,
    );
    fs.mkdirSync(path.dirname(theirs), { recursive: true });
    fs.writeFileSync(theirs, 'the conversation so far\n');

    // not in the middle of a turn: the copy is of a finished one
    await api.post(`/api/agents/${source.id}/turn`, { text: 'linger' });
    await until(
      'the agent to work',
      async () => (await agentOf(source.id)).status.state === 'working',
    );
    expect(
      (await api.post(`/api/agents/${source.id}/fork`, { name: 'mid' })).status,
    ).toBe(409);
    await api.post(`/api/agents/${source.id}/interrupt`);
    await idle(source.id);
    expect((await api.post(`/api/agents/${source.id}/fork`, {})).status).toBe(
      400,
    );

    // into a stream: a new agent there, starting in its home
    const stream = (await api.post('/api/streams', { name: 'offshoot' })).body
      .project as { id: string; path: string };
    const made = await api.post(`/api/agents/${source.id}/fork`, {
      name: 'younger',
      projectId: stream.id,
    });
    expect([made.status, made.body.message]).toEqual([201, undefined]);
    const fork = made.body.agent as { id: string; projectId: string };
    expect(made.body.agent).toMatchObject({
      name: 'younger',
      projectId: stream.id,
      cwd: stream.path,
      profile: 'fake',
      forkOf: source.id,
      forkConversation: conversation,
      vendorConversationId: null,
    });
    // the vendor looks a conversation up where the agent works: the file was copied there for it
    const copy = path.join(
      vendor,
      path.basename(stream.path),
      `${conversation}.jsonl`,
    );
    expect(fs.readFileSync(copy, 'utf8')).toBe('the conversation so far\n');
    await idle(fork.id);

    // its session began as a copy: a conversation of its own that knows where it came from
    expect(await turn(fork.id, 'whence')).toBe(`Forked from ${conversation}.`);
    const mine = (await agentOf(fork.id)).agent;
    expect(mine.vendorConversationId).not.toBe(conversation);
    expect(mine.vendorConversationId).toBeTruthy();
    expect(mine.forkConversation).toBeNull(); // from here it resumes its own
    await until('the copy to be removed', async () => !fs.existsSync(copy));
    // the original is as it was, and both flows say what happened
    expect(fs.readFileSync(theirs, 'utf8')).toBe('the conversation so far\n');
    expect((await agentOf(source.id)).agent.vendorConversationId).toBe(
      conversation,
    );
    expect(await turn(source.id, 'whence')).toBe('Not a fork.');
    await turn(source.id, 'only the elder hears this');
    expect((await system(fork.id)).join('\n')).toMatch(
      /forked from origin\/elder: it begins with that agent's whole conversation/,
    );
    expect((await system(source.id)).join('\n')).toMatch(
      /forked into offshoot\/younger: a copy of this conversation as it stands/,
    );

    // it is told what it is, once, by the hook of its resumed session
    const said = await turn(fork.id, 'token');
    const own = new Api(m.url);
    own.bearer = /token ([0-9a-f]{64})/.exec(said)![1]!;
    const notice = (await own.post('/api/dialog/handback', { on: 'resume' }))
      .body.text as string;
    expect(notice).toContain(
      'The manager, not a person: this conversation is a fork. Everything above was said to and by the agent "elder" of "origin"',
    );
    expect(notice).toContain(
      'From here on you are "younger" in the stream "offshoot"',
    );
    expect(notice).toContain(
      `The work is the stream "offshoot": a unit of work that is not tied to a repository. Its agents start in its home, ${stream.path}`,
    );
    expect(notice.length).toBeLessThan(10_000); // a hook's text is capped there
    expect(
      (await own.post('/api/dialog/handback', { on: 'resume' })).body,
    ).toEqual({ text: null });
    // an agent that is not a fork asks the same on every resume, and is told nothing
    const elderSaid = await turn(source.id, 'token');
    const elder = new Api(m.url);
    elder.bearer = /token ([0-9a-f]{64})/.exec(elderSaid)![1]!;
    expect(
      (await elder.post('/api/dialog/handback', { on: 'resume' })).body,
    ).toEqual({ text: null });

    // the dialog with the person up to the fork is the fork's too, numbered as it was, and its own follows
    expect(made.body.inherited).toBeGreaterThanOrEqual(2);
    const record = (await api.get(`/api/agents/${fork.id}/dialog`)).body
      .exchanges as { n: number; line: string }[];
    const theirsRecord = (await api.get(`/api/agents/${source.id}/dialog`)).body
      .exchanges as { n: number; line: string }[];
    expect(record.slice(0, 2).map((e) => [e.n, e.line])).toEqual(
      theirsRecord.slice(0, 2).map((e) => [e.n, e.line]),
    );
    expect(record[0]!.line).toContain('the logo is teal, never blue');
    const last = record[record.length - 1]!;
    expect(last.line).toContain('token');
    expect(last.n).toBeGreaterThan(made.body.inherited);
    // what the original says afterwards is not the fork's
    expect(record.map((e) => e.line).join('\n')).not.toContain(
      'only the elder hears this',
    );
    expect(theirsRecord.map((e) => e.line).join('\n')).toContain(
      'only the elder hears this',
    );
    const whole = (await api.get(`/api/agents/${fork.id}/dialog/1`)).body;
    expect(JSON.stringify(whole)).toContain('You said: the logo is teal');

    // a fork within the same project needs no copy: the vendor finds the conversation where it is
    const twin = await api.post(`/api/agents/${source.id}/fork`, {
      name: 'twin',
    });
    expect(twin.body.agent).toMatchObject({
      projectId: origin.id,
      cwd: origin.path,
    });
    await idle(twin.body.agent.id);
    expect(await turn(twin.body.agent.id, 'whence')).toBe(
      `Forked from ${conversation}.`,
    );
    expect(fs.existsSync(theirs)).toBe(true);

    // an agent forks within its own project; into another is a person's to do
    expect(
      (
        await elder.post(`/api/agents/${source.id}/fork`, {
          name: 'sneaky',
          projectId: stream.id,
        })
      ).status,
    ).toBe(403);
  }, 90000);
});
