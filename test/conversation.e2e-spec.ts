import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDaemon, startManager, Api, sleep } from './helpers.js';
import type { TestDaemon, TestManager } from './helpers.js';

/**
 * A conversation the vendor deletes. Claude Code removes conversation
 * files unused for thirty days, and a resume of one that is gone fails;
 * so the manager keeps a second name for each agent's file, puts the
 * file back before a resume when the vendor's name is gone, and when
 * there is nothing to put back starts a new conversation and hands the
 * dialog back to it. The fake agent keeps no file: the test plays the
 * vendor, in a directory the fake adapter is told of.
 */
let daemon: TestDaemon;
let m: TestManager;
let api: Api;
let project: { id: string };
let vendor: string;

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
    agent: { vendorConversationId: string | null };
    status: { state: string };
  };
const idle = (id: string) =>
  until('the agent to be idle', async () => {
    const a = await agentOf(id);
    return a.status.state === 'idle' && a.agent.vendorConversationId;
  });
async function turn(id: string, text: string): Promise<void> {
  const before = (await itemsOf(id)).filter((i) => i.kind === 'turn_end');
  await api.post(`/api/agents/${id}/turn`, { text });
  await until(
    'the turn to end',
    async () =>
      (await itemsOf(id)).filter((i) => i.kind === 'turn_end').length >
      before.length,
  );
  await idle(id);
}
/** The agent's own way in, as its hook has it: the token of the session running now. */
async function own(id: string): Promise<Api> {
  await turn(id, 'token');
  const said = (await itemsOf(id))
    .filter((i) => i.kind === 'text')
    .map((i) => i.text as string);
  const token = /token ([0-9a-f]{64})/.exec(said[said.length - 1]!)?.[1];
  const a = new Api(m.url);
  a.bearer = token!;
  return a;
}
async function restart(id: string): Promise<void> {
  const sessions = async () =>
    (await itemsOf(id)).filter(
      (i) => i.kind === 'system' && /^session (started|resumed)/.test(i.text),
    ).length;
  const before = await sessions();
  expect((await api.post(`/api/agents/${id}/restart`)).status).toBeLessThan(
    300,
  );
  await until('the new session', async () => (await sessions()) > before);
  await idle(id);
}
const system = async (id: string) =>
  (await itemsOf(id))
    .filter((i) => i.kind === 'system')
    .map((i) => i.text as string);

beforeAll(async () => {
  daemon = await startDaemon();
  vendor = fs.mkdtempSync(path.join(os.tmpdir(), 'am-vendor-conversations-'));
  process.env.AGENT_MANAGER_FAKE_CONVERSATIONS = vendor;
  m = await startManager(daemon.url);
  api = new Api(m.url);
  await api.login();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'am-conversation-repo-'));
  project = (
    await api.post('/api/projects', {
      name: 'forgetful',
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

describe('a conversation the vendor deletes', () => {
  it('is kept under a second name, put back before a resume, and replaced with the dialog handed back when nothing is left', async () => {
    const agent = (
      await api.post(`/api/projects/${project.id}/agents`, { name: 'elephant' })
    ).body.agent as { id: string };
    await idle(agent.id);
    await turn(agent.id, 'the logo is teal, never blue');
    const first = (await agentOf(agent.id)).agent.vendorConversationId!;
    const theirs = path.join(vendor, `${first}.jsonl`);
    const ours = path.join(
      m.dataDir,
      'conversations',
      agent.id,
      `${first}.jsonl`,
    );

    // a conversation that begins asks for its dialog like any other, and is owed none
    expect(
      (
        await (
          await own(agent.id)
        ).post('/api/dialog/handback', { on: 'start' })
      ).body,
    ).toEqual({ text: null });

    // the vendor writes its record; by the end of the next turn the manager has its own name for the same file
    fs.writeFileSync(theirs, 'one\n');
    await turn(agent.id, 'thanks');
    expect(fs.statSync(ours).ino).toBe(fs.statSync(theirs).ino);
    fs.appendFileSync(theirs, 'two\n'); // the vendor appends: both names read it
    expect(fs.readFileSync(ours, 'utf8')).toBe('one\ntwo\n');

    // replaced by a rename, as a take-back does: a new file, linked again at the next start
    fs.writeFileSync(`${theirs}.tmp`, 'one\n');
    fs.renameSync(`${theirs}.tmp`, theirs);
    expect(fs.statSync(ours).ino).not.toBe(fs.statSync(theirs).ino);
    await restart(agent.id);
    expect(fs.statSync(ours).ino).toBe(fs.statSync(theirs).ino);
    expect(fs.readFileSync(ours, 'utf8')).toBe('one\n');

    // the vendor deletes its name: put back before the resume, the same conversation
    fs.rmSync(theirs);
    await restart(agent.id);
    expect(fs.readFileSync(theirs, 'utf8')).toBe('one\n');
    expect((await agentOf(agent.id)).agent.vendorConversationId).toBe(first);
    expect((await system(agent.id)).join('\n')).toMatch(
      /put back from the manager's copy, and resumed/,
    );
    expect((await system(agent.id)).join('\n')).not.toMatch(
      /a new conversation begins/,
    );

    // nothing left of it anywhere: a new conversation, told so, with the dialog handed back
    fs.rmSync(theirs);
    fs.rmSync(ours);
    await restart(agent.id);
    const second = (await agentOf(agent.id)).agent.vendorConversationId;
    expect(second).not.toBe(first);
    expect((await system(agent.id)).join('\n')).toMatch(
      /the CLI's record of the earlier conversation is gone from this machine, so a new conversation begins/,
    );
    const hook = await own(agent.id);
    const { text } = (await hook.post('/api/dialog/handback', { on: 'start' }))
      .body as { text: string };
    expect(text).toContain('This is a new conversation, but not a new agent');
    const file = path.join(m.dataDir, 'handback', agent.id, 'dialog-1.md');
    expect(text).toContain(file);
    expect(fs.readFileSync(file, 'utf8')).toMatch(
      /admin:\nthe logo is teal, never blue\n\nYou:\nYou said: the logo is teal, never blue/,
    );
    expect((await system(agent.id)).pop()).toMatch(
      /^dialog handed back to the new conversation: /,
    );
    // once: the next conversation to begin is owed nothing
    expect(
      (await hook.post('/api/dialog/handback', { on: 'start' })).body,
    ).toEqual({ text: null });
  }, 60000);

  it('leaves an agent whose vendor has kept nothing where the manager looks to its resume', async () => {
    // a directory that does not exist: nothing shows the vendor keeps conversations there
    process.env.AGENT_MANAGER_FAKE_CONVERSATIONS = path.join(
      vendor,
      'elsewhere',
    );
    try {
      const agent = (
        await api.post(`/api/projects/${project.id}/agents`, {
          name: 'goldfish',
        })
      ).body.agent as { id: string };
      await idle(agent.id);
      await turn(agent.id, 'hello');
      const first = (await agentOf(agent.id)).agent.vendorConversationId;
      await restart(agent.id);
      expect((await agentOf(agent.id)).agent.vendorConversationId).toBe(first);
      expect((await system(agent.id)).join('\n')).not.toMatch(
        /a new conversation begins/,
      );
    } finally {
      process.env.AGENT_MANAGER_FAKE_CONVERSATIONS = vendor;
    }
  }, 60000);
});
