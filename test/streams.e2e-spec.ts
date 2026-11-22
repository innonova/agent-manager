import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDaemon, startManager, Api, sleep } from './helpers.js';
import type { TestDaemon, TestManager } from './helpers.js';

/**
 * Streams (`docs/streams.md`): a unit of work with a folder of its own
 * in the store and a home with its own clones, recorded as a project of
 * another kind so that agents, chats and tokens work as they do for a
 * project.
 */
let daemon: TestDaemon;
let m: TestManager;
let api: Api;
let streams: string;
let store: string;
let source: string;

async function until<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  ms = 15_000,
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
    { cwd, encoding: 'utf8' },
  );
const itemsOf = async (id: string) =>
  (await api.get(`/api/agents/${id}/items`)).body.items.map(
    (i: any) => i.item,
  ) as any[];
const idle = (id: string) =>
  until(
    'the agent to be idle',
    async () =>
      (await api.get(`/api/agents/${id}`)).body.status.state === 'idle',
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
  return said[said.length - 1]!;
}
const clonesOf = async (id: string) =>
  (await api.get(`/api/projects/${id}/clones`)).body.clones as {
    name: string;
    state: string;
    branch: string | null;
    message: string | null;
  }[];
const settled = (id: string, name: string) =>
  until(`${name} to be cloned or to fail`, async () => {
    const c = (await clonesOf(id)).find((x) => x.name === name);
    return c && (c.state === 'ready' || c.state === 'failed') ? c : null;
  });

beforeAll(async () => {
  daemon = await startDaemon();
  m = await startManager(daemon.url, undefined, { storeCommitMs: 150 });
  streams = path.join(m.dataDir, 'streams');
  store = path.join(streams, '.store');
  api = new Api(m.url);
  await api.login();
  // a repository somewhere else, with features of its own and a file git does not hold
  source = fs.mkdtempSync(path.join(os.tmpdir(), 'am-stream-source-'));
  git(source, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(source, 'features'));
  fs.writeFileSync(
    path.join(source, 'features', 'old.md'),
    '---\ntitle: something this repository once did\nstatus: done\npriority: 1\n---\n\nlong ago\n',
  );
  fs.writeFileSync(path.join(source, 'CLAUDE.md'), '# thing\n');
  fs.writeFileSync(path.join(source, '.gitignore'), '.env\n.setup-ran\n');
  git(source, 'add', '-A');
  git(source, 'commit', '-qm', 'a thing');
  fs.writeFileSync(path.join(source, '.env'), 'SECRET=not-in-git\n');
}, 30000);

afterAll(async () => {
  await m?.stop();
  await daemon?.stop();
});

describe('a stream', () => {
  let tidy: { id: string; path: string };

  it('starts with a folder in the store, a home that links to it, and one commit of the manager', async () => {
    // nothing is made before the first stream
    expect(fs.existsSync(streams)).toBe(false);
    for (const name of ['Tidy', 'with space', '-x', '', 'stream/x'])
      expect((await api.post('/api/streams', { name })).status).toBe(400);
    const made = await api.post('/api/streams', {
      name: 'tidy',
      purpose: 'Keep the shed in order.',
      defaultProfile: 'fake',
    });
    expect([made.status, made.body.message]).toEqual([201, undefined]);
    tidy = made.body.project;
    const home = path.join(streams, 'tidy');
    expect(made.body.project).toMatchObject({
      name: 'tidy',
      kind: 'stream',
      path: home,
      defaultProfile: 'fake',
      repos: [{ name: 'stream', path: path.join(store, 'tidy'), folder: true }],
    });
    // the folder, with what the stream is for in the words it was started with
    expect(
      fs.readFileSync(path.join(store, 'tidy', 'AGENTS.md'), 'utf8'),
    ).toContain('# tidy\n\nKeep the shed in order.');
    // the home: not a repository, the folder linked in, the instruction file where loaders look
    expect(fs.existsSync(path.join(home, '.git'))).toBe(false);
    expect(fs.readlinkSync(path.join(home, 'stream'))).toBe('../.store/tidy');
    expect(fs.readlinkSync(path.join(home, 'CLAUDE.md'))).toBe(
      'stream/AGENTS.md',
    );
    expect(fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8')).toContain(
      'Keep the shed in order.',
    );
    // the store is a repository, and the stream's start is a commit of the manager's
    expect(git(store, 'log', '--format=%an: %s').trim().split('\n')).toEqual([
      'agent-manager: tidy: started by admin',
      'agent-manager: store: README.md',
    ]);
    expect(git(store, 'status', '--porcelain')).toBe('');

    // listed with the projects, as what it is; its name is taken and stays
    const listed = (await api.get('/api/projects')).body.map(
      (x: any) => `${x.project.name}:${x.project.kind}`,
    );
    expect(listed).toContain('tidy:stream');
    expect((await api.post('/api/streams', { name: 'tidy' })).status).toBe(409);
    expect(
      (await api.call('PATCH', `/api/projects/${tidy.id}`, { name: 'neat' }))
        .status,
    ).toBe(400);
    expect(
      (
        await api.call('PATCH', `/api/projects/${tidy.id}`, {
          delegation: 'on-request',
        })
      ).body.project.delegation,
    ).toBe('on-request');
    // a group is a label to list it under, for a stream and a project alike
    expect(made.body.project.group).toBeNull();
    const grouped = await api.call('PATCH', `/api/projects/${tidy.id}`, {
      group: ' household ',
    });
    expect(grouped.body.project).toMatchObject({
      group: 'household',
      delegation: 'on-request',
    });
    expect(
      (await api.call('PATCH', `/api/projects/${tidy.id}`, { group: '' })).body
        .project.group,
    ).toBeNull();
    expect(
      (
        await api.call('PATCH', `/api/projects/${tidy.id}`, {
          group: 'x'.repeat(61),
        })
      ).status,
    ).toBe(400);
    const born = await api.post('/api/streams', {
      name: 'grouped-from-birth',
      group: 'household',
    });
    expect(born.body.project.group).toBe('household');
  }, 30000);

  it('has agents that start in the home and are told what a stream is', async () => {
    const agent = (
      await api.post(`/api/projects/${tidy.id}/agents`, { name: 'worker' })
    ).body.agent as { id: string; cwd: string };
    expect(agent.cwd).toBe(tidy.path);
    await idle(agent.id);
    const note = await turn(agent.id, 'note');
    expect(note).toContain(
      `The work is the stream "tidy": a unit of work that is not tied to a repository. Its agents start in its home, ${tidy.path}, which is not a repository.`,
    );
    expect(note).toContain('directories beside it: none yet.');
    expect(note).toContain('a branch named `tidy/<topic>`');
    expect(note).toContain('`stream/features/<slug>.md` in its home');
    expect(note).not.toContain('its repositories:');
    expect(note).not.toMatch(/\{\{\w+\}\}/);
    // the agent's own token: the registry and its own clones, not starting streams
    const said = await turn(agent.id, 'token');
    const own = new Api(m.url);
    own.bearer = /token ([0-9a-f]{64})/.exec(said)![1]!;
    expect((await own.get('/api/repositories')).status).toBe(200);
    expect((await own.get(`/api/projects/${tidy.id}/clones`)).status).toBe(200);
    expect((await own.post('/api/streams', { name: 'mine' })).status).toBe(403);
    expect((await own.call('DELETE', '/api/repositories/thing')).status).toBe(
      403,
    );
  }, 60000);

  it('clones a repository from the registry into its home, with the seed files and the setup run', async () => {
    expect((await api.get('/api/repositories')).body.repositories).toEqual([]);
    for (const bad of ['stream', '../x', '.hidden'])
      expect(
        (
          await api.call(
            'PUT',
            `/api/repositories/${encodeURIComponent(bad)}`,
            {
              source,
            },
          )
        ).status,
      ).toBeGreaterThanOrEqual(400);
    expect(
      (await api.call('PUT', '/api/repositories/thing', { source: '-x' }))
        .status,
    ).toBe(400);
    const put = await api.call('PUT', '/api/repositories/thing', {
      source,
      setup: 'test -f .env && echo ran > .setup-ran',
    });
    expect(put.body.repository).toMatchObject({
      name: 'thing',
      source,
      setup: 'test -f .env && echo ran > .setup-ran',
      seed: [],
      usedBy: [],
    });
    // what git does not hold comes from a checkout, by name, and not from outside it
    expect(
      (
        await api.call('PUT', '/api/repositories/thing/seed', {
          from: source,
          files: ['../etc/passwd'],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api.call('PUT', '/api/repositories/thing/seed', {
          from: source,
          files: ['.env'],
        })
      ).body.repository.seed,
    ).toEqual(['.env']);

    // only a stream has a home to clone into, and only what is registered is cloned
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'am-stream-plain-'));
    const plain = (
      await api.post('/api/projects', { name: 'plain', path: repo })
    ).body.project;
    expect(
      (
        await api.post(`/api/projects/${plain.id}/clones`, {
          repository: 'thing',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api.post(`/api/projects/${tidy.id}/clones`, {
          repository: 'nope',
        })
      ).status,
    ).toBe(404);

    const started = await api.post(`/api/projects/${tidy.id}/clones`, {
      repository: 'thing',
    });
    expect([started.status, started.body.clone.state]).toEqual([
      202,
      'cloning',
    ]);
    const clone = await settled(tidy.id, 'thing');
    expect(clone).toMatchObject({
      state: 'ready',
      branch: 'main',
      message: null,
    });
    const at = path.join(tidy.path, 'thing');
    expect(fs.readFileSync(path.join(at, '.env'), 'utf8')).toBe(
      'SECRET=not-in-git\n',
    );
    expect(fs.readFileSync(path.join(at, '.setup-ran'), 'utf8')).toBe('ran\n');
    expect(git(at, 'status', '--porcelain')).toBe('');
    expect(fs.readdirSync(tidy.path).sort()).toEqual([
      'AGENTS.md',
      'CLAUDE.md',
      'stream',
      'thing',
    ]);
    // the disk is the record: the stream now has the clone, and the registry says who uses it
    expect(
      (await api.get(`/api/projects/${tidy.id}`)).body.project.repos.map(
        (r: any) => r.name,
      ),
    ).toEqual(['stream', 'thing']);
    expect(
      (await api.get('/api/repositories')).body.repositories[0].usedBy,
    ).toEqual(['tidy']);
    // nothing of it is unlanded yet; then a branch with a commit, a changed file, and main moving on
    const landingOf = async () =>
      (
        (await api.get(`/api/projects/${tidy.id}/clones`)).body.clones as any[]
      ).find((c) => c.name === 'thing').landing;
    expect(await landingOf()).toEqual({
      main: 'origin/main',
      unlanded: 0,
      behind: 0,
      uncommitted: 0,
    });
    git(at, 'checkout', '-q', '-b', 'tidy/shelves');
    fs.writeFileSync(path.join(at, 'shelves.txt'), 'three\n');
    git(at, 'add', '-A');
    git(at, 'commit', '-qm', 'shelves');
    fs.writeFileSync(path.join(at, 'scratch.txt'), 'x\n');
    fs.appendFileSync(path.join(at, 'CLAUDE.md'), 'more\n');
    fs.writeFileSync(path.join(source, 'elsewhere.txt'), 'someone else\n');
    git(source, 'add', 'elsewhere.txt');
    git(source, 'commit', '-qm', 'someone else landed');
    git(at, 'fetch', '-q');
    expect(await landingOf()).toEqual({
      main: 'origin/main',
      unlanded: 1,
      behind: 1,
      uncommitted: 2,
    });
    git(at, 'checkout', '-q', '--', 'CLAUDE.md');
    fs.rmSync(path.join(at, 'scratch.txt'));
    git(at, 'checkout', '-q', 'main');
    // one clone of a repository per stream
    expect(
      (
        await api.post(`/api/projects/${tidy.id}/clones`, {
          repository: 'thing',
        })
      ).status,
    ).toBe(409);

    // a setup that fails leaves the clone, and says what the command said
    await api.call('PUT', '/api/repositories/brittle', {
      source,
      setup: 'echo no such tool >&2; exit 3',
    });
    await api.post(`/api/projects/${tidy.id}/clones`, {
      repository: 'brittle',
    });
    const failed = await settled(tidy.id, 'brittle');
    expect(failed.state).toBe('failed');
    expect(failed.message).toContain('the clone is there; its setup');
    expect(failed.message).toContain('no such tool');
    expect(fs.existsSync(path.join(tidy.path, 'brittle', '.git'))).toBe(true);
    // and a source that cannot be cloned leaves nothing
    await api.call('PUT', '/api/repositories/ghost', {
      source: path.join(source, 'does-not-exist'),
    });
    await api.post(`/api/projects/${tidy.id}/clones`, { repository: 'ghost' });
    const ghost = await settled(tidy.id, 'ghost');
    expect(ghost.state).toBe('failed');
    expect(ghost.message).toContain('git clone');
    expect(fs.existsSync(path.join(tidy.path, 'ghost'))).toBe(false);
    // what is left beside the clones is only the note that brittle's setup is not done
    expect(fs.readdirSync(tidy.path).filter((n) => n.startsWith('.'))).toEqual([
      '.brittle.setup-pending',
    ]);
    // its setup is run again on request, once the command is right, and never by itself
    const refused = await api.post(`/api/projects/${tidy.id}/clones`, {
      repository: 'brittle',
    });
    expect([refused.status, refused.body.message]).toEqual([
      409,
      expect.stringContaining('its setup did not finish'),
    ]);
    await api.call('PUT', '/api/repositories/brittle', {
      setup: 'echo mended > .setup-ran',
    });
    const again = await api.post(`/api/projects/${tidy.id}/clones`, {
      repository: 'brittle',
      again: true,
    });
    expect([again.status, again.body.clone.state]).toEqual([202, 'setting up']);
    expect((await settled(tidy.id, 'brittle')).state).toBe('ready');
    expect(
      fs.readFileSync(path.join(tidy.path, 'brittle', '.setup-ran'), 'utf8'),
    ).toBe('mended\n');
    expect(fs.readdirSync(tidy.path).filter((n) => n.startsWith('.'))).toEqual(
      [],
    );
    // A manager restarted while a setup ran finds a clone that looks whole:
    // the note left beside it says it is not, until the setup is run again.
    fs.writeFileSync(path.join(tidy.path, '.thing.setup-pending'), 'npm ci');
    const interrupted = (await clonesOf(tidy.id)).find(
      (c) => c.name === 'thing',
    )!;
    expect(interrupted.state).toBe('failed');
    expect(interrupted.message).toContain(
      'its setup did not finish (the manager was restarted while it ran)',
    );
    await api.post(`/api/projects/${tidy.id}/clones`, {
      repository: 'thing',
      again: true,
    });
    expect((await settled(tidy.id, 'thing')).state).toBe('ready');
    expect(fs.existsSync(path.join(tidy.path, '.thing.setup-pending'))).toBe(
      false,
    );
    // nothing to run again for a repository without a setup
    await api.call('PUT', '/api/repositories/plainrepo', { source });
    await api.post(`/api/projects/${tidy.id}/clones`, {
      repository: 'plainrepo',
    });
    expect((await settled(tidy.id, 'plainrepo')).state).toBe('ready');
    expect(
      (
        await api.post(`/api/projects/${tidy.id}/clones`, {
          repository: 'plainrepo',
          again: true,
        })
      ).status,
    ).toBe(400);
  }, 60000);

  it("keeps its features in its own folder, and leaves a clone's features to the work they belong to", async () => {
    const made = await api.post(`/api/projects/${tidy.id}/features`, {
      slug: 'sweep-the-floor',
      title: 'sweep the floor',
      body: 'every corner',
    });
    expect([made.status, made.body.message]).toEqual([201, undefined]);
    const file = path.join(store, 'tidy', 'features', 'sweep-the-floor.md');
    expect(fs.readFileSync(file, 'utf8')).toContain('title: sweep the floor');
    // through the link, it is the same file an agent in the home would write
    expect(
      fs.existsSync(
        path.join(tidy.path, 'stream', 'features', 'sweep-the-floor.md'),
      ),
    ).toBe(true);
    const listed = (await api.get(`/api/projects/${tidy.id}/features`)).body
      .features as { slug: string; repo: string }[];
    expect(listed.map((f) => `${f.repo}/${f.slug}`)).toEqual([
      'stream/sweep-the-floor',
    ]);
    // a feature cannot be put into a clone from here
    expect(
      (
        await api.post(`/api/projects/${tidy.id}/features`, {
          slug: 'in-the-clone',
          title: 'x',
          repo: 'thing',
        })
      ).status,
    ).toBe(400);
    // the views built on repositories answer for a stream: its clones, not its folder
    expect((await api.get(`/api/projects/${tidy.id}/commits`)).status).toBe(
      200,
    );
    expect((await api.get(`/api/projects/${tidy.id}/changes`)).status).toBe(
      200,
    );
    expect((await api.get(`/api/projects/${tidy.id}/files`)).status).toBe(200);
  }, 30000);

  it('has what changes in its folder committed by the manager, a stream at a time', async () => {
    const other = (await api.post('/api/streams', { name: 'other' })).body
      .project as { id: string; path: string };
    const committed = async (subject: string) =>
      until(`the commit "${subject}"`, async () =>
        git(store, 'log', '--format=%s').split('\n').includes(subject),
      );
    await committed('other: started by admin');
    await committed('tidy: features/sweep-the-floor.md');
    // written the way an agent writes: through the links in the two homes, at the same moment
    const before = git(store, 'rev-parse', 'HEAD').trim();
    fs.mkdirSync(path.join(tidy.path, 'stream', 'docs'));
    fs.writeFileSync(path.join(tidy.path, 'stream', 'docs', 'plan.md'), 'a\n');
    fs.appendFileSync(path.join(tidy.path, 'stream', 'AGENTS.md'), '\nmore\n');
    fs.writeFileSync(path.join(other.path, 'stream', 'notes.md'), 'b\n');
    // every commit since holds one stream's files and is named for it (the
    // sweep may come between two writes, so how many commits is not fixed)
    const since = () =>
      git(
        store,
        'log',
        '--reverse',
        '--name-only',
        '--format=%x00%s',
        `${before}..HEAD`,
      )
        .split('\0')
        .filter(Boolean)
        .map((c) => {
          const [subject, ...files] = c.trim().split('\n').filter(Boolean);
          return { subject: subject!, files };
        });
    await until('all three files to be committed', async () => {
      const files = since().flatMap((c) => c.files);
      return (
        ['tidy/docs/plan.md', 'tidy/AGENTS.md', 'other/notes.md'].every((f) =>
          files.includes(f),
        ) && git(store, 'status', '--porcelain') === ''
      );
    });
    for (const c of since()) {
      const stream = c.subject.slice(0, c.subject.indexOf(':'));
      expect(['tidy', 'other']).toContain(stream);
      expect(c.files.every((f) => f.startsWith(`${stream}/`))).toBe(true);
      // and says which files, by their paths in the stream's folder
      for (const f of c.files)
        expect(c.subject).toContain(f.slice(stream.length + 1));
    }
    // The store's remote: a push that fails is tried again at the next
    // sweep, without waiting for another edit to bring it about.
    const remote = path.join(m.dataDir, 'store-remote.git');
    git(store, 'remote', 'add', 'origin', remote); // not there yet: the push fails
    fs.writeFileSync(path.join(other.path, 'stream', 'later.md'), 'c\n');
    await committed('other: later.md');
    await sleep(600); // a few sweeps with nothing new and no remote to reach
    git(m.dataDir, 'init', '-q', '--bare', '-b', 'main', remote);
    await until('the store to reach its remote', async () => {
      try {
        return git(remote, 'log', '--format=%s', 'main').includes(
          'other: later.md',
        );
      } catch {
        return false;
      }
    });
    // Who may have caused a change is in the commit's body: whoever wrote
    // through the manager, and the stream's agents that had a turn since.
    const bodyOf = (subject: string) =>
      git(store, 'log', '-1', '--format=%b', `--grep=^${subject}$`).trim();
    const put = await fetch(
      `${m.url}/api/projects/${other.id}/file?path=stream/via-api.md`,
      {
        method: 'PUT',
        headers: {
          cookie: api.cookie,
          'content-type': 'application/octet-stream',
        },
        body: 'through the manager\n',
      },
    );
    expect(put.status).toBeLessThan(300);
    await committed('other: via-api.md');
    expect(bodyOf('other: via-api.md')).toBe(
      'Written through the manager by admin.',
    );
    const quiet = (
      await api.post(`/api/projects/${other.id}/agents`, {
        name: 'scribe',
        profile: 'fake',
      })
    ).body.agent as { id: string };
    await idle(quiet.id);
    await sleep(400); // its start is not a turn; let a sweep pass
    await api.post(`/api/agents/${quiet.id}/turn`, { text: 'a slow answer' });
    fs.writeFileSync(path.join(other.path, 'stream', 'in-a-turn.md'), 'd\n');
    await committed('other: in-a-turn.md');
    expect(bodyOf('other: in-a-turn.md')).toBe(
      'scribe had a turn in the stream since its last commit.',
    );
    await idle(quiet.id);
    await sleep(400);
    // its turn went on after that commit, so it is named once more; then nobody is
    fs.writeFileSync(path.join(other.path, 'stream', 'after.md'), 'e\n');
    await committed('other: after.md');
    expect(bodyOf('other: after.md')).toBe(
      'scribe had a turn in the stream since its last commit.',
    );
    fs.writeFileSync(path.join(other.path, 'stream', 'nobody.md'), 'f\n');
    await committed('other: nobody.md');
    expect(bodyOf('other: nobody.md')).toBe('');
    // a clone is not in the store, whatever happens in it
    fs.writeFileSync(path.join(tidy.path, 'thing', 'scratch.txt'), 'x\n');
    await sleep(500);
    expect(git(store, 'log', '--format=%s')).not.toContain('scratch');
  }, 30000);
});
