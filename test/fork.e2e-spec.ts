import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDaemon, startManager, Api, sleep } from './helpers.js';
import type { TestDaemon, TestManager } from './helpers.js';

/**
 * Forking an agent: a new one, in another project or stream, that
 * begins with the first one's whole conversation and its dialog with
 * the person, and is told that it is a copy. The fake agent keeps its
 * conversations on disk here, a file per conversation from its first
 * turn, and refuses to resume or fork one that is not there, so a fork
 * that could not find its copy fails as it would with the real CLI.
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
  // the fake keeps its conversations on disk and refuses to resume one that is not there, as Claude Code does
  process.env.AGENT_MANAGER_FAKE_CONVERSATIONS_STRICT = '1';
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
  delete process.env.AGENT_MANAGER_FAKE_CONVERSATIONS_STRICT;
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
    // (the agent exists, and has said nothing: the vendor has written no conversation yet)
    await turn(source.id, 'the logo is teal, never blue');
    await turn(source.id, 'we ship on Fridays');
    const conversation = (await agentOf(source.id)).agent.vendorConversationId!;
    const theirs = path.join(
      vendor,
      path.basename(origin.path),
      `${conversation}.jsonl`,
    );

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

    // what the vendor has written of the conversation by the moment of the fork
    const soFar = fs.readFileSync(theirs, 'utf8');
    expect(soFar).toContain('we ship on Fridays');

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
    });
    // The vendor looks a conversation up where the agent works: the file
    // was copied there for it, or its session could not have started.
    const copy = path.join(
      vendor,
      path.basename(stream.path),
      `${conversation}.jsonl`,
    );
    await idle(fork.id);

    // its session began as a copy: a conversation of its own that knows where it came from
    expect(await turn(fork.id, 'whence')).toBe(`Forked from ${conversation}.`);
    const mine = (await agentOf(fork.id)).agent;
    expect(mine.vendorConversationId).not.toBe(conversation);
    expect(mine.vendorConversationId).toBeTruthy();
    expect(mine.forkConversation).toBeNull(); // from here it resumes its own
    // which the vendor wrote, beginning with everything the original's held at the fork
    const own = fs.readFileSync(
      path.join(
        vendor,
        path.basename(stream.path),
        `${mine.vendorConversationId}.jsonl`,
      ),
      'utf8',
    );
    expect(own.startsWith(soFar)).toBe(true);
    expect(own).toContain('whence');
    await until('the copy to be removed', async () => !fs.existsSync(copy));
    // a restart resumes its own conversation, with the copy gone
    await api.post(`/api/agents/${fork.id}/restart`);
    await idle(fork.id);
    expect(await turn(fork.id, 'whence')).toBe('Not a fork.');
    expect((await agentOf(fork.id)).agent.vendorConversationId).toBe(
      mine.vendorConversationId,
    );
    // the original is as it was, and both flows say what happened
    expect(fs.readFileSync(theirs, 'utf8')).toBe(soFar);
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

    // it is told what it is by the hook of its resumed session
    const said = await turn(fork.id, 'token');
    const hook = new Api(m.url);
    hook.bearer = /token ([0-9a-f]{64})/.exec(said)![1]!;
    const notice = (await hook.post('/api/dialog/handback', { on: 'resume' }))
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
    // an answer can be lost on its way to the hook: asked again before it has taken a turn, it is told again
    expect(
      (await hook.post('/api/dialog/handback', { on: 'resume' })).body.text,
    ).toBe(notice);
    // A session that asked and ended without a turn proves nothing about
    // the next: one that takes a turn without having asked is still owed it.
    await api.post(`/api/agents/${fork.id}/restart`);
    await idle(fork.id);
    const next = new Api(m.url);
    next.bearer = /token ([0-9a-f]{64})/.exec(
      await turn(fork.id, 'token'),
    )![1]!;
    expect(
      (await next.post('/api/dialog/handback', { on: 'resume' })).body.text,
    ).toBe(notice);
    // and once it has taken a turn in a session that was handed the notice, never again
    await turn(fork.id, 'understood');
    expect(
      (await next.post('/api/dialog/handback', { on: 'resume' })).body,
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
    expect(last.line).toContain('understood');
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

    // Two forks into one place would start from one copied file, and a
    // fork that has not been spoken to starts from it again if it is
    // restarted. So there is one such fork at a time: of two asked for at
    // the same moment one is made, and the other is told why not yet.
    const both = await Promise.all(
      ['first-twin', 'second-twin'].map((name) =>
        api.post(`/api/agents/${source.id}/fork`, {
          name,
          projectId: stream.id,
        }),
      ),
    );
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    const won = both.find((r) => r.status === 201)!.body.agent as {
      id: string;
      name: string;
    };
    expect(both.find((r) => r.status === 409)!.body.message).toContain(
      `"${won.name}" was forked from this agent into the same place and has not been spoken to yet`,
    );
    await idle(won.id);
    // restarted before its first turn, it still finds the conversation it begins as
    await api.post(`/api/agents/${won.id}/restart`);
    await idle(won.id);
    expect(fs.existsSync(copy)).toBe(true);
    expect(await turn(won.id, 'whence')).toMatch(/^Forked from /);
    await until('the copy to be removed', async () => !fs.existsSync(copy));
    // and now that it has a conversation of its own, the other can be made
    const later = await api.post(`/api/agents/${source.id}/fork`, {
      name: 'the-other-twin',
      projectId: stream.id,
    });
    expect([later.status, later.body.message]).toEqual([201, undefined]);
    await idle(later.body.agent.id);
    expect(await turn(later.body.agent.id, 'whence')).toMatch(/^Forked from /);

    // an archived agent can be forked: what it knew is not lost with it
    await api.post(`/api/agents/${twin.body.agent.id}/archive`);
    const revived = await api.post(`/api/agents/${twin.body.agent.id}/fork`, {
      name: 'from-the-archive',
    });
    expect([revived.status, revived.body.message]).toEqual([201, undefined]);
    expect(revived.body.inherited).toBeGreaterThanOrEqual(3);
    await idle(revived.body.agent.id);

    // an agent forks within its own project; into another is a person's to do
    expect(
      (
        await elder.post(`/api/agents/${source.id}/fork`, {
          name: 'sneaky',
          projectId: stream.id,
        })
      ).status,
    ).toBe(403);

    // And after a restart of the manager, when an archived agent's
    // transcript is not in memory until something asks for it: its dialog
    // is brought in for the fork all the same.
    const dataDir = m.dataDir;
    await m.stop();
    m = await startManager(daemon.url, dataDir);
    api = new Api(m.url);
    await api.login();
    const cold = await api.post(`/api/agents/${twin.body.agent.id}/fork`, {
      name: 'from-the-cold',
    });
    expect([cold.status, cold.body.message]).toEqual([201, undefined]);
    expect(cold.body.inherited).toBe(revived.body.inherited);
    const coldRecord = (
      await api.get(`/api/agents/${cold.body.agent.id}/dialog`)
    ).body.exchanges as { n: number; line: string }[];
    expect(coldRecord[0]!.line).toContain('the logo is teal, never blue');
  }, 90000);
});
