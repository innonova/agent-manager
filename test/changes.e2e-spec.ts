import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuthService } from '../src/auth/auth.service.js';
import {
  Api,
  TestDaemon,
  TestManager,
  sleep,
  startDaemon,
  startManager,
} from './helpers.js';

let daemon: TestDaemon;
let m: TestManager;
let api: Api;
let repo: string;
let plain: string;
let projectId: string;

const git = (...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t.t', ...args],
    {
      cwd: repo,
    },
  )
    .toString()
    .trim();
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};

beforeAll(async () => {
  daemon = await startDaemon();
  m = await startManager(daemon.url);
  api = new Api(m.url);
  await api.login();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'am-changes-'));
  plain = fs.mkdtempSync(path.join(os.tmpdir(), 'am-plain-'));
  git('init', '-q');
  write('README.md', 'one\n');
  write('src/a.ts', 'a1\n');
  write('.gitignore', 'dist/\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  const r = await api.post('/api/projects', {
    name: 'changes',
    repos: [
      { name: 'repo', path: repo },
      { name: 'plain', path: plain },
    ],
  });
  projectId = r.body.project.id;
}, 30000);

afterAll(async () => {
  await m?.stop();
  await daemon?.stop();
});

describe('changes', () => {
  it('lists working-tree changes since the read cursor, with untracked and renamed files; a non-repo has none', async () => {
    const before = await api.get(`/api/projects/${projectId}/changes`);
    expect(before.status).toBe(200);
    const [r0, p0] = before.body.repos;
    expect(r0).toMatchObject({ repo: 'repo', files: [] });
    expect(r0.note).toMatch(/nothing marked read yet/);
    expect(p0).toMatchObject({ repo: 'plain', base: null, files: [] });

    await api.post(`/api/projects/${projectId}/changes/read`, {});
    write('src/a.ts', 'a2\n'); // modified, uncommitted
    write('src/new.ts', 'n\n'); // untracked
    write('dist/bundle.js', ''); // ignored: not a change
    git('mv', 'README.md', 'README.txt'); // renamed, staged
    write('src/c.ts', 'c\n');
    git('add', 'src/c.ts');
    git('commit', '-q', '-m', 'second'); // committed after the cursor
    const r = await api.get(`/api/projects/${projectId}/changes`);
    const repo0 = r.body.repos[0];
    expect(repo0.note).toBeNull();
    expect(repo0.files).toEqual([
      { path: 'repo/README.txt', status: 'renamed', oldPath: 'repo/README.md' },
      { path: 'repo/src/a.ts', status: 'modified' },
      { path: 'repo/src/c.ts', status: 'added' },
      { path: 'repo/src/new.ts', status: 'untracked' },
    ]);
  });

  it('serves before and after content for a changed file', async () => {
    const d = await api.get(
      `/api/projects/${projectId}/changes/file?path=${encodeURIComponent('repo/src/a.ts')}`,
    );
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({
      before: 'a1\n',
      after: 'a2\n',
      binary: false,
    });
    const added = await api.get(
      `/api/projects/${projectId}/changes/file?path=${encodeURIComponent('repo/src/new.ts')}`,
    );
    expect(added.body).toMatchObject({ before: null, after: 'n\n' });
    expect(
      (await api.get(`/api/projects/${projectId}/changes/file?path=nope`))
        .status,
    ).toBe(404);
  });

  it('accepts a commit as the base and rejects an unknown one', async () => {
    const first = git('rev-list', '--max-parents=0', 'HEAD');
    const r = await api.get(`/api/projects/${projectId}/changes?base=${first}`);
    expect(r.body.repos[0].base).toBe(first);
    expect(r.body.repos[0].files.map((f: any) => f.path)).toContain(
      'repo/src/c.ts',
    );
    expect(
      (await api.get(`/api/projects/${projectId}/changes?base=nope`)).status,
    ).toBe(400);
  });

  it('marking read moves the cursor to HEAD, leaving only uncommitted work; per-user', async () => {
    await api.post(`/api/projects/${projectId}/changes/read`, { repo: 'repo' });
    const r = await api.get(`/api/projects/${projectId}/changes`);
    expect(
      r.body.repos[0].files.map((f: any) => `${f.status}:${f.path}`),
    ).toEqual([
      // the rename went into the second commit, which is now read; the rest is uncommitted
      'modified:repo/src/a.ts',
      'untracked:repo/src/new.ts',
    ]);
    const other = new Api(m.url);
    await m.app.get(AuthService).createUser('bob', 'bob-password');
    await other.login('bob', 'bob-password');
    const theirs = await other.get(`/api/projects/${projectId}/changes`);
    expect(theirs.body.repos[0].note).toMatch(/nothing marked read yet/);
  });

  it("a feature's range is recorded at in-progress and done, and serves as a base", async () => {
    fs.mkdirSync(path.join(repo, 'features'), { recursive: true });
    const file = path.join(repo, 'features', 'thing.md');
    const front = (st: string) =>
      `---\ntitle: Thing\nstatus: ${st}\n---\n\nDo the thing.\n`;
    fs.writeFileSync(file, front('planned'));
    await sleep(3500); // poller sees the file
    const baseHead = git('rev-parse', 'HEAD');
    fs.writeFileSync(file, front('in-progress'));
    await sleep(3500);
    let f = await api.get(`/api/projects/${projectId}/features/thing`);
    expect(f.body.feature.range).toEqual({
      repo: { base: baseHead, end: null },
    });
    write('src/d.ts', 'd\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'the thing');
    fs.writeFileSync(file, front('review'));
    await sleep(3500);
    const done = await api.patch(`/api/projects/${projectId}/features/thing`, {
      status: 'done',
    });
    const endHead = git('rev-parse', 'HEAD');
    expect(done.body.feature.range).toEqual({
      repo: { base: baseHead, end: endHead },
    });
    const r = await api.get(
      `/api/projects/${projectId}/changes?base=feature:thing`,
    );
    expect(r.body.repos[0].base).toBe(baseHead);
    expect(r.body.repos[0].files.map((x: any) => x.path)).toContain(
      'repo/src/d.ts',
    );
    expect(r.body.repos[0].note).toMatch(/feature ended at/);
    // done moved the caller's read cursor: nothing committed is unread now
    const read = await api.get(`/api/projects/${projectId}/changes`);
    expect(read.body.repos[0].base).toBe(endHead);
    const none = await api.get(
      `/api/projects/${projectId}/changes?base=feature:nothing`,
    );
    expect(none.body.repos[0].note).toMatch(/no range recorded/);
  }, 30000);

  it('a rewritten history falls back to HEAD with a note', async () => {
    await api.post(`/api/projects/${projectId}/changes/read`, { repo: 'repo' });
    git('commit', '-q', '--allow-empty', '-m', 'to amend');
    await api.post(`/api/projects/${projectId}/changes/read`, { repo: 'repo' });
    git('reset', '-q', '--hard', 'HEAD~1');
    git('reflog', 'expire', '--expire=now', '--all');
    git('gc', '-q', '--prune=now');
    const r = await api.get(`/api/projects/${projectId}/changes`);
    expect(r.body.repos[0].note).toMatch(/no longer exists/);
  }, 30000);
});
