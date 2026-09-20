import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Api, TestDaemon, TestManager, sleep, startDaemon, startManager } from './helpers.js';

let daemon: TestDaemon;
let m: TestManager;
let api: Api;
let repo: string;
let projectId: string;
let agentId: string;

const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.t', ...args], {
    cwd: repo,
  })
    .toString()
    .trim();

/** The commit row for HEAD, once it appears (recordCommit is async, fire-and-forget). */
async function headRow(): Promise<Record<string, unknown> | undefined> {
  const wanted = git('rev-parse', 'HEAD');
  for (let i = 0; i < 50; i++) {
    const r = await api.get(`/api/projects/${projectId}/commits`);
    const row = r.body.commits.find((c: { hash: string }) => c.hash === wanted);
    if (row?.agentId) return row;
    await sleep(100);
  }
  return undefined;
}

beforeAll(async () => {
  daemon = await startDaemon();
  m = await startManager(daemon.url);
  api = new Api(m.url);
  await api.login();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'am-commitattr-'));
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'the work');
  const p = await api.post('/api/projects', {
    name: 'attr',
    repos: [{ name: 'repo', path: repo }],
    defaultProfile: 'fake',
  });
  projectId = p.body.project.id;
  const a = await api.post(`/api/projects/${projectId}/agents`, { name: 'maker' });
  agentId = a.body.agent.id;
}, 30000);

afterAll(async () => {
  await m?.stop();
  await daemon?.stop();
});

describe('a commit is attributed to the turn that made it', () => {
  it('records the agent, session and item when the vendor reports a commit, over the git author', async () => {
    // the fake agent announces a commit on a turn whose text contains "commit";
    // it makes no real one, so HEAD is the fixture commit, now attributed to the agent
    await api.post(`/api/agents/${agentId}/turn`, { text: 'please commit' });
    const row = await headRow();
    expect(row).toBeDefined();
    expect(row!.agent).toBe('maker'); // the agent, not the git author "t"
    expect(row!.agentId).toBe(agentId);
    expect(typeof row!.sessionId).toBe('string');
    expect(typeof row!.item).toBe('number');
    const fresh = (await api.get(`/api/agents/${agentId}`)).body.agent;
    expect(row!.sessionId).toBe(fresh.currentSessionId);
  }, 30000);

  it('survives a manager restart and transcript rebuild', async () => {
    await m.stop();
    m = await startManager(daemon.url, m.dataDir);
    api = new Api(m.url);
    await api.login();
    const wanted = git('rev-parse', 'HEAD');
    const r = await api.get(`/api/projects/${projectId}/commits`);
    const row = r.body.commits.find((c: { hash: string }) => c.hash === wanted);
    expect(row?.agent).toBe('maker'); // the row is on disk; replay does not overwrite it
    expect(typeof row?.item).toBe('number');
  }, 30000);
});
