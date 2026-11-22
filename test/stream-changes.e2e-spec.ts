import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDaemon, startManager, Api, sleep } from './helpers.js';
import type { TestDaemon, TestManager } from './helpers.js';

/**
 * What a stream changed (`docs/design.md`, "What a stream changed"): its
 * clones are whole repositories with everybody's history in them, so
 * the commit list of a stream is the stream's own commits unless the
 * repository's is asked for; and a run of a stream's feature says where
 * each clone stood when it began and ended.
 */
let daemon: TestDaemon;
let m: TestManager;
let api: Api;
let remote: string;
let store: string;

/** How often the manager re-reads feature files (FeaturesService's POLL_MS). */
const POLL_MS = 3000;

async function until<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  ms = 20_000,
): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
const stateOf = async (id: string) =>
  (await api.get(`/api/agents/${id}`)).body.status.state as string;
const commitsOf = async (id: string, q = '') =>
  (await api.get(`/api/projects/${id}/commits${q}`)).body as {
    commits: any[];
    working: any[];
    sinceCount: number;
  };
const subjects = async (id: string, q = '') =>
  (await commitsOf(id, q)).commits.map((c) => c.subject as string);

/** A stream with its own clone of the one repository and an agent. */
async function streamWith(name: string) {
  const project = (
    await api.post('/api/streams', { name, defaultProfile: 'fake' })
  ).body.project as { id: string; path: string };
  await api.post(`/api/projects/${project.id}/clones`, { repository: 'lib' });
  await until('the clone', async () =>
    (
      (await api.get(`/api/projects/${project.id}/clones`)).body.clones as any[]
    ).some((c) => c.name === 'lib' && c.state === 'ready'),
  );
  const agent = (
    await api.post(`/api/projects/${project.id}/agents`, { name: 'worker' })
  ).body.agent as { id: string };
  await until('the agent', async () => (await stateOf(agent.id)) === 'idle');
  return { ...project, clone: path.join(project.path, 'lib'), agent: agent.id };
}
const commit = (cwd: string, file: string, message: string) => {
  fs.writeFileSync(path.join(cwd, file), `${message}\n`);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
};

beforeAll(async () => {
  daemon = await startDaemon();
  m = await startManager(daemon.url, undefined, { storeCommitMs: 150 });
  store = path.join(m.dataDir, 'streams', '.store');
  api = new Api(m.url);
  await api.login();
  remote = fs.mkdtempSync(path.join(os.tmpdir(), 'am-streamchanges-'));
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'am-streamchanges-seed-'));
  git(seed, 'clone', '-q', remote, '.');
  commit(seed, 'README.md', 'the beginning');
  commit(seed, 'lib.txt', 'long before any stream');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  await api.put('/api/repositories/lib', { source: remote });
}, 30000);

afterAll(async () => {
  await m?.stop();
  await daemon?.stop();
});

describe('what a stream changed', () => {
  let alpha: Awaited<ReturnType<typeof streamWith>>;
  let beta: Awaited<ReturnType<typeof streamWith>>;

  it('lists the stream’s own commits, and the repository’s only on request', async () => {
    alpha = await streamWith('alpha');
    beta = await streamWith('beta');
    // a fresh clone holds the repository's history and nothing of the stream's
    expect(await subjects(alpha.id)).toEqual([]);
    expect((await commitsOf(alpha.id)).sinceCount).toBe(0);
    expect(await subjects(alpha.id, '?scope=repository')).toEqual([
      'long before any stream',
      'the beginning',
    ]);
    // work on a branch of the stream's, for a feature of the stream's
    git(alpha.clone, 'checkout', '-q', '-b', 'alpha/one');
    const made = commit(
      alpha.clone,
      'a.txt',
      'alpha’s first\n\nFeature: alpha/first',
    );
    const list = await commitsOf(alpha.id);
    expect(list.commits).toMatchObject([
      {
        repo: 'lib',
        hash: made,
        subject: 'alpha’s first',
        feature: 'first',
        unread: true,
      },
    ]);
    expect(list.sinceCount).toBe(1);
    expect(
      (await api.get(`/api/projects/${alpha.id}/commits?count=1`)).body
        .sinceCount,
    ).toBe(1);
    // the other stream, on the same repository, sees none of it
    expect(await subjects(beta.id)).toEqual([]);
    // by feature, and read
    expect(await subjects(alpha.id, '?feature=first')).toEqual([
      'alpha’s first',
    ]);
    expect(await subjects(alpha.id, '?feature=other')).toEqual([]);
    await sleep(1100); // a commit's time is in seconds
    await api.post(`/api/projects/${alpha.id}/changes/read`);
    expect((await commitsOf(alpha.id)).sinceCount).toBe(0);
    expect((await commitsOf(alpha.id)).commits[0].unread).toBe(false);
  }, 60000);

  it('names the agent whose turn made a commit from the stream’s home', async () => {
    // an agent of a stream works from the home, which is no repository: its commit is reported from there
    await sleep(1100);
    const made = commit(alpha.clone, 'b.txt', 'alpha’s second');
    await api.post(`/api/agents/${alpha.agent}/turn`, { text: 'commit that' });
    const row = await until('the commit to be the agent’s', async () => {
      const c = (await commitsOf(alpha.id)).commits.find(
        (x) => x.hash === made,
      );
      return c?.agentId ? c : null;
    });
    expect(row).toMatchObject({
      agent: 'worker',
      agentId: alpha.agent,
      unread: true,
    });
    expect(row.item).toBeGreaterThan(0);
    expect(await subjects(alpha.id, `?agent=${alpha.agent}`)).toEqual([
      'alpha’s second',
    ]);
    await until(
      'the agent',
      async () => (await stateOf(alpha.agent)) === 'idle',
    );
  }, 30000);

  it('keeps a commit the stream’s after the rebase that lands it, and another stream’s out', async () => {
    // beta lands first
    git(beta.clone, 'checkout', '-q', '-b', 'beta/x');
    commit(beta.clone, 'x.txt', 'beta’s work\n\nFeature: beta/x');
    git(beta.clone, 'push', '-q', 'origin', 'HEAD:main');
    git(beta.clone, 'fetch', '-q', 'origin');
    // landed, it is still beta's: its message says so
    expect(await subjects(beta.id)).toEqual(['beta’s work']);
    // alpha finds main moved, rebases, lands
    git(alpha.clone, 'fetch', '-q', 'origin');
    git(
      alpha.clone,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      'rebase',
      '-q',
      'origin/main',
    );
    git(alpha.clone, 'push', '-q', 'origin', 'HEAD:main');
    git(alpha.clone, 'fetch', '-q', 'origin');
    const after = await commitsOf(alpha.id);
    // both are still alpha's, under new hashes: the first by its trailer, the second by the turn that made it
    expect(after.commits.map((c) => [c.subject, c.feature, c.agent])).toEqual([
      ['alpha’s second', null, 'worker'],
      ['alpha’s first', 'first', null],
    ]);
    expect(after.commits[0].item).toBeGreaterThan(0); // and the moment in the flow is still linked
    // the repository's history has all of it
    expect(await subjects(alpha.id, '?scope=repository')).toEqual([
      'alpha’s second',
      'alpha’s first',
      'beta’s work',
      'long before any stream',
      'the beginning',
    ]);
    // a project is as it was: its repository's commits, all of them
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'am-streamchanges-p-'));
    git(plain, 'clone', '-q', remote, '.');
    const project = (
      await api.post('/api/projects', { name: 'plain', path: plain })
    ).body.project;
    expect((await subjects(project.id)).length).toBe(5);
  }, 60000);

  it('records where each clone stood when a run of a stream’s feature began and ended', async () => {
    const features = path.join(store, 'alpha', 'features');
    fs.mkdirSync(features, { recursive: true });
    const write = (status: string, body: string) =>
      fs.writeFileSync(
        path.join(features, 'second.md'),
        `---\ntitle: second\nstatus: ${status}\npriority: 1\n---\n\n${body}\n`,
      );
    write('planned', 'More of alpha.');
    await until('the poller to see the feature', async () =>
      (
        (await api.get(`/api/projects/${alpha.id}/features`)).body
          .features as any[]
      )?.some((f) => f.slug === 'second'),
    );
    await sleep(POLL_MS + 500);
    await api.post(`/api/agents/${alpha.agent}/turn`, {
      text: 'linger please',
    });
    await until(
      'the agent to be working',
      async () => (await stateOf(alpha.agent)) === 'working',
    );
    const base = git(alpha.clone, 'rev-parse', 'HEAD');
    write('in-progress', 'More of alpha.');
    const runsOf = async () =>
      (await api.get(`/api/runs?project=${alpha.id}&feature=second`)).body
        .runs as any[];
    const open = await until(
      'the run to open',
      async () => (await runsOf())[0],
    );
    expect(open.repo).toBe('stream'); // the feature is in the stream's folder
    expect(open.clones).toEqual([{ name: 'lib', base, end: null }]);
    await sleep(1100);
    const end = commit(
      alpha.clone,
      'c.txt',
      'alpha’s third\n\nFeature: alpha/second',
    );
    await api.post(`/api/agents/${alpha.agent}/interrupt`);
    await until(
      'the turn to end',
      async () => (await stateOf(alpha.agent)) === 'idle',
    );
    write('review', 'More of alpha.\n\n## Report (2026-11-22)\n\nDone.');
    const closed = await until('the run to close', async () => {
      const [run] = await runsOf();
      return run?.endedAt ? run : null;
    });
    expect(closed.clones).toEqual([{ name: 'lib', base, end }]);
    // and the commit is the feature's, and the run's agent's
    const row = (await commitsOf(alpha.id)).commits.find((c) => c.hash === end);
    expect(row).toMatchObject({
      subject: 'alpha’s third',
      feature: 'second',
      agent: 'worker',
      unread: true,
    });
  }, 90000);
});
