import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DbService } from '../src/db/db.service.js';
import { Api, TestDaemon, TestManager, startDaemon, startManager } from './helpers.js';

let daemon: TestDaemon;
let m: TestManager;
let api: Api;
let repo: string;
let projectId: string;
const c: string[] = []; // c[0]..c[5], the commit hashes in order

const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.t', ...args], {
    cwd: repo,
  })
    .toString()
    .trim();
const commit = (rel: string, text: string, msg: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
  git('add', '-A');
  git('commit', '-q', '-m', msg);
  return git('rev-parse', 'HEAD');
};

/** Inserts a run directly, so attribution can be tested without live agents. */
function insertRun(run: {
  slug: string;
  agent: string;
  base: string;
  end: string | null;
  startedAt: number;
}) {
  m.app
    .get(DbService)
    .db.prepare(
      `INSERT INTO runs (id, project_id, project_name, host, repo, slug, agent_id, agent_name, profile, permissions, started_at, ended_at, base_commit, end_commit, item_from)
       VALUES (?, ?, 'commits', 'local', 'repo', ?, ?, ?, 'fake', 'bypass', ?, ?, ?, ?, 0)`,
    )
    .run(
      randomUUID(),
      projectId,
      run.slug,
      `agent-${run.agent}`,
      run.agent,
      run.startedAt,
      run.end ? run.startedAt + 100 : null,
      run.base,
      run.end,
    );
}

beforeAll(async () => {
  daemon = await startDaemon();
  m = await startManager(daemon.url);
  api = new Api(m.url);
  await api.login();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'am-commits-'));
  git('init', '-q');
  c[0] = commit('a.ts', 'a0\n', 'c0');
  c[1] = commit('a.ts', 'a1\n', 'c1');
  c[2] = commit('a.ts', 'a2\n', 'c2');
  c[3] = commit('b.ts', 'b3\n', 'c3');
  c[4] = commit('a.ts', 'a4\n', 'c4');
  c[5] = commit('a.ts', 'a5\n', 'c5');
  const r = await api.post('/api/projects', {
    name: 'commits',
    repos: [{ name: 'repo', path: repo }],
  });
  projectId = r.body.project.id;
  // Two overlapping run windows in one repo:
  //   feat-a: c0..c5  → {c1,c2,c3,c4,c5}
  //   feat-b: c2..c4  → {c3,c4}
  insertRun({ slug: 'feat-a', agent: 'alice', base: c[0], end: c[5], startedAt: 1000 });
  insertRun({ slug: 'feat-b', agent: 'bob', base: c[2], end: c[4], startedAt: 2000 });
}, 30000);

afterAll(async () => {
  await m?.stop();
  await daemon?.stop();
});

describe('commits list and attribution', () => {
  it('lists commits newest first and attributes each to the innermost run window', async () => {
    const r = await api.get(`/api/projects/${projectId}/commits`);
    expect(r.status).toBe(200);
    const by = new Map<string, { feature: string | null; agent: string | null }>();
    for (const row of r.body.commits)
      by.set(row.hash, { feature: row.feature, agent: row.agent });
    // newest first
    expect(r.body.commits[0].hash).toBe(c[5]);
    // c5 is only in feat-a's window
    expect(by.get(c[5])).toEqual({ feature: 'feat-a', agent: 'alice' });
    // c4 and c3 are in both; the innermost (feat-b, base c2 the later ancestor) wins
    expect(by.get(c[4])).toEqual({ feature: 'feat-b', agent: 'bob' });
    expect(by.get(c[3])).toEqual({ feature: 'feat-b', agent: 'bob' });
    // c2 is feat-b's base, so excluded from its window; only feat-a contains it
    expect(by.get(c[2])).toEqual({ feature: 'feat-a', agent: 'alice' });
    expect(by.get(c[1])).toEqual({ feature: 'feat-a', agent: 'alice' });
    // c0 is feat-a's base: in no window, so the git author and no feature
    expect(by.get(c[0])).toEqual({ feature: null, agent: null });
    expect(r.body.commits.find((x: any) => x.hash === c[0]).author).toBe('t');
  });

  it('filters by feature and by agent', async () => {
    const f = await api.get(`/api/projects/${projectId}/commits?feature=feat-b`);
    expect(f.body.commits.map((x: any) => x.hash).sort()).toEqual([c[3], c[4]].sort());
    const alice = await api.get(
      `/api/projects/${projectId}/commits?agent=agent-alice`,
    );
    expect(alice.body.commits.map((x: any) => x.hash).sort()).toEqual(
      [c[1], c[2], c[5]].sort(),
    );
  });

  it('serves a commit diff: the file list, and a file before and after', async () => {
    const meta = await api.get(`/api/projects/${projectId}/commits/repo/${c[5]}`);
    expect(meta.status).toBe(200);
    expect(meta.body.subject).toBe('c5');
    expect(meta.body.files).toEqual([{ path: 'a.ts', status: 'modified' }]);
    const diff = await api.get(
      `/api/projects/${projectId}/commits/repo/${c[5]}?path=a.ts`,
    );
    expect(diff.body).toMatchObject({ before: 'a4\n', after: 'a5\n', binary: false });
    // the root commit shows its files as added, with no before
    const rootDiff = await api.get(
      `/api/projects/${projectId}/commits/repo/${c[0]}?path=a.ts`,
    );
    expect(rootDiff.body).toMatchObject({ before: null, after: 'a0\n' });
  });

  it('the unread count counts commits after the read cursor', async () => {
    await api.post(`/api/projects/${projectId}/changes/read`, {});
    const zero = await api.get(`/api/projects/${projectId}/commits?count=1`);
    expect(zero.body.sinceCount).toBe(0);
    commit('a.ts', 'a6\n', 'c6');
    const one = await api.get(`/api/projects/${projectId}/commits?count=1`);
    expect(one.body.sinceCount).toBe(1);
    const list = await api.get(`/api/projects/${projectId}/commits`);
    expect(list.body.commits[0].unread).toBe(true);
    expect(list.body.commits.find((x: any) => x.hash === c[5]).unread).toBe(false);
  });

  it('a working tree with uncommitted changes shows as a row', async () => {
    fs.writeFileSync(path.join(repo, 'a.ts'), 'dirty\n');
    const r = await api.get(`/api/projects/${projectId}/commits`);
    expect(r.body.working).toMatchObject([{ repo: 'repo', agent: null, files: 1 }]);
    expect(r.body.working[0].head).toMatch(/^[0-9a-f]{40}$/);
    git('checkout', '--', 'a.ts'); // clean up for the next test
  });

  it('after an amend the list is re-read from git; a truly vanished hash is a 404', async () => {
    const before = git('rev-parse', 'HEAD');
    git('commit', '-q', '--amend', '-m', 'c6 amended');
    const after = git('rev-parse', 'HEAD');
    expect(after).not.toBe(before);
    // nothing is cached: the list reflects the new history at once
    const r = await api.get(`/api/projects/${projectId}/commits`);
    const hashes = r.body.commits.map((x: any) => x.hash);
    expect(hashes).toContain(after);
    expect(hashes).not.toContain(before);
    // once the old object is really gone (not just unreferenced), its diff 404s
    git('reflog', 'expire', '--expire=now', '--all');
    git('gc', '-q', '--prune=now');
    expect(
      (await api.get(`/api/projects/${projectId}/commits/repo/${before}`)).status,
    ).toBe(404);
  }, 30000);
});
