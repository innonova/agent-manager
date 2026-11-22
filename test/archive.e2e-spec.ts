import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDaemon, startManager, Api, sleep } from './helpers.js';
import type { TestDaemon, TestManager } from './helpers.js';

/**
 * A stream put away and brought back (`docs/design.md`, "A stream put
 * away"): nothing that exists only in a clone goes with the clones, the
 * agents and the folder stay, and what comes back knows what it missed.
 */
let daemon: TestDaemon;
let m: TestManager;
let api: Api;
let streams: string;
let store: string;
let remote: string;
let work: string;

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
    { cwd, encoding: 'utf8' },
  );
const itemsOf = async (id: string) =>
  (await api.get(`/api/agents/${id}/items`)).body.items.map(
    (i: any) => i.item,
  ) as any[];
const stateOf = async (id: string) =>
  (await api.get(`/api/agents/${id}`)).body.status.state as string;
async function turn(id: string, text: string): Promise<string> {
  const ends = async () =>
    (await itemsOf(id)).filter((i) => i.kind === 'turn_end').length;
  const before = await ends();
  const sent = await api.post(`/api/agents/${id}/turn`, { text });
  expect(sent.status).toBeLessThan(300);
  await until('the turn to end', async () => (await ends()) > before);
  await until(
    'the agent to be idle',
    async () => (await stateOf(id)) === 'idle',
  );
  const said = (await itemsOf(id))
    .filter((i) => i.kind === 'text')
    .map((i) => i.text as string);
  return said[said.length - 1]!;
}
const archiveOf = async (id: string) =>
  (await api.get(`/api/projects/${id}/archive`)).body as {
    archive: { state: string; at: number } | null;
    progress: {
      step: string | null;
      error: string | null;
      done: string | null;
    };
    record: any;
  };
const listed = async (q = '') =>
  ((await api.get(`/api/projects${q}`)).body as any[]).map(
    (x) => x.project.name as string,
  );

beforeAll(async () => {
  daemon = await startDaemon();
  m = await startManager(daemon.url, undefined, {
    storeCommitMs: 150,
    archiveCompactMinTokens: 0, // the fake agent says nothing of its context's size
  });
  streams = path.join(m.dataDir, 'streams');
  store = path.join(streams, '.store');
  api = new Api(m.url);
  await api.login();
  // a remote nobody works in, and a checkout of it to move its main with
  remote = fs.mkdtempSync(path.join(os.tmpdir(), 'am-archive-remote-'));
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'am-archive-work-'));
  git(work, 'clone', '-q', remote, '.');
  fs.writeFileSync(path.join(work, 'lib.txt'), 'one\n');
  fs.writeFileSync(path.join(work, '.gitignore'), '.env\n.setup-ran\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'a thing');
  git(work, 'push', '-q', 'origin', 'HEAD:main');
  fs.writeFileSync(path.join(work, '.env'), 'SECRET=not-in-git\n');
}, 30000);

afterAll(async () => {
  await m?.stop();
  await daemon?.stop();
});

describe('a stream put away and brought back', () => {
  let tidy: { id: string; path: string };
  let agent: { id: string };
  let clone: string;
  let head: string;

  it('is not put away while work exists only in a clone, and says what', async () => {
    const made = await api.post('/api/streams', {
      name: 'tidy',
      purpose: 'Tidy the thing.',
      defaultProfile: 'fake',
    });
    expect(made.status).toBe(201);
    tidy = made.body.project;
    await api.put('/api/repositories/thing', {
      source: remote,
      setup: 'touch .setup-ran',
    });
    await api.put('/api/repositories/thing/seed', {
      from: work,
      files: ['.env'],
    });
    expect(
      (
        await api.post(`/api/projects/${tidy.id}/clones`, {
          repository: 'thing',
        })
      ).status,
    ).toBe(202);
    clone = path.join(tidy.path, 'thing');
    await until('the clone', async () =>
      (
        (await api.get(`/api/projects/${tidy.id}/clones`)).body.clones as any[]
      ).some((c) => c.name === 'thing' && c.state === 'ready'),
    );
    agent = (
      await api.post(`/api/projects/${tidy.id}/agents`, { name: 'worker' })
    ).body.agent;
    await turn(agent.id, 'hello');

    // a commit on main that is not landed, a branch of the stream's with one, a file nobody committed
    fs.writeFileSync(path.join(clone, 'lib.txt'), 'one\nunlanded\n');
    git(clone, 'commit', '-qam', 'straight onto main');
    git(clone, 'checkout', '-q', '-b', 'tidy/work', 'origin/main');
    fs.writeFileSync(path.join(clone, 'lib.txt'), 'one\ntwo\n');
    git(clone, 'commit', '-qam', 'the second line');
    head = git(clone, 'rev-parse', 'HEAD').trim();
    fs.writeFileSync(path.join(clone, 'probe.log'), 'what I found\n');

    const plan = (await api.get(`/api/projects/${tidy.id}/archive/plan`)).body
      .plan;
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]).toContain(
      'thing: 1 commit on main that is not landed',
    );
    expect(plan.pushes).toEqual([
      { clone: 'thing', branch: 'tidy/work', commits: 1 },
    ]);
    expect(plan.uncommitted).toEqual([
      { clone: 'thing', count: 1, files: ['probe.log'], stashes: 0 },
    ]);
    expect(plan.agents).toMatchObject([{ name: 'worker', compact: true }]);
    expect(plan.clones).toMatchObject([{ name: 'thing', branch: 'tidy/work' }]);

    const refused = await api.post(`/api/projects/${tidy.id}/archive`, {
      discard: true,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('archive-refused');
    expect(refused.body.message).toContain('not landed');
    expect(refused.body.plan.pushes).toHaveLength(1);
    expect((await archiveOf(tidy.id)).archive).toBeNull();
    // nothing was pushed for a stream that stayed
    expect(git(remote, 'branch', '--list').trim()).toBe('* main');

    // the commit on main goes to a branch of the stream's, which is pushed as it is
    git(clone, 'branch', 'tidy/straight', 'main');
    git(clone, 'branch', '-f', 'main', 'origin/main');

    // what is somewhere else is what its remote has now: not what another remote was once seen to have
    git(clone, 'update-ref', 'refs/remotes/backup/work', head);
    const planOf = async () =>
      (await api.get(`/api/projects/${tidy.id}/archive/plan`)).body.plan;
    expect((await planOf()).pushes.map((x: any) => x.branch)).toEqual([
      'tidy/straight',
      'tidy/work',
    ]);
    git(clone, 'update-ref', '-d', 'refs/remotes/backup/work');
    // a tag the remote does not have would go with the clone: it stands in the way, by name
    git(clone, 'tag', '-a', 'v0', '-m', 'the first', head);
    expect((await planOf()).blocked).toEqual([
      'thing: tags/v0 is not on the remote as it is here: push it, or delete it if not wanted',
    ]);
    git(clone, 'tag', '-d', 'v0');
    // a remote that cannot be asked proves nothing about what it holds
    git(clone, 'remote', 'set-url', 'origin', path.join(remote, 'nowhere'));
    expect((await planOf()).blocked).toContain(
      'thing: its remote could not be asked, so it cannot be told which of its commits are there',
    );
    git(clone, 'remote', 'set-url', 'origin', remote);
    // a question git does not answer is not "nothing to save"
    const index = path.join(clone, '.git', 'index');
    const good = fs.readFileSync(index);
    fs.writeFileSync(index, 'not an index');
    expect(
      ((await planOf()).blocked as string[]).some((b) =>
        b.startsWith(
          'thing: it could not be told which files are not committed (',
        ),
      ),
    ).toBe(true);
    expect(
      (await api.post(`/api/projects/${tidy.id}/archive`, { discard: true }))
        .status,
    ).toBe(409);
    fs.writeFileSync(index, good);
    // a file git was told not to look at may have changed unseen: it is listed with the rest
    git(clone, 'update-index', '--assume-unchanged', 'lib.txt');
    expect((await planOf()).uncommitted[0].files).toEqual([
      'probe.log',
      'lib.txt (hidden from git status)',
    ]);
    git(clone, 'update-index', '--no-assume-unchanged', 'lib.txt');
    const again = await api.post(`/api/projects/${tidy.id}/archive`, {});
    expect(again.status).toBe(409);
    expect(again.body.message).toContain(
      'thing: 1 file not committed (probe.log) would be lost',
    );
    expect(again.body.message).not.toContain('not landed');
    expect(fs.existsSync(path.join(clone, 'probe.log'))).toBe(true);

    // and not while an agent is in a turn
    await api.post(`/api/agents/${agent.id}/turn`, { text: 'a slow answer' });
    const busy = await api.post(`/api/projects/${tidy.id}/archive`, {
      discard: true,
    });
    expect(busy.status).toBe(409);
    expect(busy.body.message).toContain('the agent "worker" is in a turn');
    await until(
      'the turn to end',
      async () => (await stateOf(agent.id)) === 'idle',
    );
  }, 60000);

  it('goes away with its clones off the disk, its branches pushed, its agents compacted and stopped, and a record in its folder', async () => {
    // letting go of what was shown is not letting go of what turned up since
    const shown = (await api.get(`/api/projects/${tidy.id}/archive/plan`)).body
      .plan.uncommittedKey as string;
    fs.writeFileSync(path.join(clone, 'later.log'), 'after the look\n');
    const stale = await api.post(`/api/projects/${tidy.id}/archive`, {
      discard: shown,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.message).toContain(
      'what is not committed in its clones is no longer what you were shown',
    );
    fs.rmSync(path.join(clone, 'later.log'));
    // nor of more in a file that was listed: the name is the same, the work is not
    const was = fs.readFileSync(path.join(clone, 'probe.log'));
    fs.writeFileSync(
      path.join(clone, 'probe.log'),
      'what I found\nand then some\n',
    );
    expect(
      (await api.post(`/api/projects/${tidy.id}/archive`, { discard: shown }))
        .status,
    ).toBe(409);
    fs.writeFileSync(path.join(clone, 'probe.log'), was);
    const seen = (await api.get(`/api/projects/${tidy.id}/archive/plan`)).body
      .plan.uncommittedKey as string;
    expect(seen).not.toBe(shown); // written again, it is not what was shown either
    // asked for twice at once, it is put away once
    const both = await Promise.all([
      api.post(`/api/projects/${tidy.id}/archive`, { discard: seen }),
      api.post(`/api/projects/${tidy.id}/archive`, { discard: seen }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([202, 409]);
    const put = both.find((r) => r.status === 202)!;
    expect(put.status).toBe(202);
    expect(put.body.project.archive.state).toBe('archiving');
    const away = await until('the stream to be away', async () => {
      const s = await archiveOf(tidy.id);
      if (s.progress.error) throw new Error(s.progress.error);
      return s.archive?.state === 'archived' && !s.progress.step ? s : null;
    });
    expect(away.progress.done).toMatch(
      /^put away by admin: 1 clone removed \(under 1 MB\), 1 of 1 agent compacted$/,
    );
    // the clone is gone; the home and what it links to are not
    expect(fs.existsSync(clone)).toBe(false);
    expect(fs.readdirSync(tidy.path).sort()).toEqual([
      'AGENTS.md',
      'CLAUDE.md',
      'stream',
    ]);
    // both branches are on the remote, with the commits
    expect(git(remote, 'rev-parse', 'tidy/work').trim()).toBe(head);
    expect(
      git(remote, 'log', '-1', '--format=%s', 'tidy/straight').trim(),
    ).toBe('straight onto main');
    // the record, in the stream's folder and in the store's history
    const record = JSON.parse(
      fs.readFileSync(path.join(store, 'tidy', 'archived.json'), 'utf8'),
    );
    expect(record).toMatchObject({
      by: 'admin',
      clones: [
        {
          name: 'thing',
          source: remote,
          branch: 'tidy/work',
          head,
          main: { ref: 'origin/main' },
          pushed: ['tidy/straight', 'tidy/work'],
        },
      ],
      agents: [{ name: 'worker', compacted: true }],
    });
    expect(away.record).toEqual(record);
    await until('the store to say so', async () =>
      git(store, 'log', '--format=%s').includes('tidy: put away by admin'),
    );
    // the agent was compacted, by the manager, and is stopped
    const items = await itemsOf(agent.id);
    expect(items.some((i) => i.kind === 'user' && i.text === '/compact')).toBe(
      true,
    );
    expect(
      items.some(
        (i) =>
          i.kind === 'system' && i.text === 'the stream was put away by admin',
      ),
    ).toBe(true);
    expect(await stateOf(agent.id)).toBe('exited');

    // out of the list, and in the list of what is away
    expect(await listed()).not.toContain('tidy');
    expect(await listed('?archived=1')).toEqual(['tidy']);
    // nothing is said to it, started in it or cloned into it
    const said = await api.post(`/api/agents/${agent.id}/turn`, { text: 'hi' });
    expect(said.status).toBe(409);
    expect(said.body.message).toContain('the stream "tidy" is put away');
    expect(
      (await api.post(`/api/projects/${tidy.id}/agents`, { name: 'late' }))
        .status,
    ).toBe(409);
    expect(
      (
        await api.post(`/api/projects/${tidy.id}/clones`, {
          repository: 'thing',
        })
      ).status,
    ).toBe(409);
    expect(
      (await api.post(`/api/projects/${tidy.id}/archive`, {})).status,
    ).toBe(409);
    // nor is a session of one of its agents started
    const restarted = await api.post(`/api/agents/${agent.id}/restart`);
    expect(restarted.status).toBe(409);
    expect(restarted.body.message).toContain('is put away');
  }, 60000);

  it('is not an agent’s to put away or bring back', async () => {
    const other = (await api.post('/api/streams', { name: 'other' })).body
      .project;
    const a = (
      await api.post(`/api/projects/${other.id}/agents`, {
        name: 'a',
        profile: 'fake',
      })
    ).body.agent;
    const its = new Api(m.url);
    its.bearer = /token ([0-9a-f]{64})/.exec(await turn(a.id, 'token'))![1]!;
    expect((await its.get(`/api/projects/${other.id}/archive`)).status).toBe(
      200,
    );
    expect(
      (await its.post(`/api/projects/${other.id}/archive`, {})).status,
    ).toBe(403);
    expect(
      (await its.post(`/api/projects/${other.id}/revive`, {})).status,
    ).toBe(403);
    // however the address is spelled
    for (const tail of ['archive/', 'ARCHIVE', 'revive/', 'Revive'])
      expect(
        (await its.post(`/api/projects/${other.id}/${tail}`, { discard: true }))
          .status,
      ).toBe(403);
    expect((await archiveOf(other.id)).archive).toBeNull();
  }, 30000);

  it('comes back with its clones made again and its agents told what landed meanwhile', async () => {
    // main moves on while the stream is away
    fs.writeFileSync(path.join(work, 'other.txt'), 'a\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-qm', 'somebody else landed this');
    fs.writeFileSync(path.join(work, 'other.txt'), 'a\nb\n');
    git(work, 'commit', '-qam', 'and this');
    git(work, 'push', '-q', 'origin', 'HEAD:main');

    const back = await api.post(`/api/projects/${tidy.id}/revive`);
    expect(back.status).toBe(202);
    expect(back.body.project.archive.state).toBe('reviving');
    const here = await until('the stream to be back', async () => {
      const s = await archiveOf(tidy.id);
      if (s.progress.error) throw new Error(s.progress.error);
      return !s.archive && !s.progress.step ? s : null;
    });
    expect(here.progress.done).toMatch(
      /^brought back by admin after \d+ minutes?: 1 of 1 clone made again$/,
    );
    expect(await listed()).toContain('tidy');
    expect(await listed('?archived=1')).toEqual([]);
    // the clone: on the branch it was on, with what was pushed, seeded and set up
    expect(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(
      'tidy/work',
    );
    expect(git(clone, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(fs.readFileSync(path.join(clone, '.env'), 'utf8')).toBe(
      'SECRET=not-in-git\n',
    );
    expect(fs.existsSync(path.join(clone, '.setup-ran'))).toBe(true);
    expect(fs.existsSync(path.join(clone, 'probe.log'))).toBe(false); // gone on a person's word
    // the record is no longer in the folder; the store's history has it
    expect(fs.existsSync(path.join(store, 'tidy', 'archived.json'))).toBe(
      false,
    );
    await until('the store to say so', async () =>
      git(store, 'log', '--format=%s').includes('tidy: brought back by admin'),
    );

    // the agent answers again, and its session's hook is told what it missed
    const its = new Api(m.url);
    its.bearer = /token ([0-9a-f]{64})/.exec(
      await turn(agent.id, 'token'),
    )![1]!;
    const told = (await its.post('/api/dialog/handback', { on: 'resume' })).body
      .text as string;
    expect(told).toContain('This stream was put away on ');
    expect(told).toContain('by admin');
    expect(told).toContain(
      `- thing: was at ${head.slice(0, 7)} on tidy/work (tidy/straight, tidy/work were pushed when the stream was put away); the clone is on tidy/work now.`,
    );
    expect(told).toMatch(
      /origin\/main was at [0-9a-f]{7} and is at [0-9a-f]{7}: 2 commits landed meanwhile:\n {4}[0-9a-f]{7} and this\n {4}[0-9a-f]{7} somebody else landed this/,
    );
    // told until a turn has ended in a session that asked, and then no more
    await turn(agent.id, 'hello again');
    expect(
      (await its.post('/api/dialog/handback', { on: 'resume' })).body.text ??
        null,
    ).toBeNull();
    expect(
      (await itemsOf(agent.id)).some(
        (i) =>
          i.kind === 'system' &&
          /^the stream was brought back by admin after \d+ minutes?; the agent is told at its next start/.test(
            i.text,
          ),
      ),
    ).toBe(true);
  }, 60000);

  it('tells an agent it has no hooks in ahead of the first thing said to it, once however often it was away; restores a branch the remote never had by name; puts away a stream that has cloned nothing', async () => {
    const other = ((await api.get('/api/projects')).body as any[]).find(
      (x) => x.project.name === 'other',
    ).project;
    const a = (await api.get(`/api/projects/${other.id}/agents`)).body[0].agent;
    // a clone on a branch that holds nothing the remote lacks: nothing to push, and the name is its own
    await api.post(`/api/projects/${other.id}/clones`, { repository: 'thing' });
    const idle = path.join(other.path, 'thing');
    await until('the clone', async () =>
      (
        (await api.get(`/api/projects/${other.id}/clones`)).body.clones as any[]
      ).some((c) => c.name === 'thing' && c.state === 'ready'),
    );
    git(idle, 'checkout', '-q', '-b', 'other/idle');
    const at = git(idle, 'rev-parse', 'HEAD').trim();
    const cycle = async () => {
      expect(
        (await api.post(`/api/projects/${other.id}/archive`, {})).status,
      ).toBe(202);
      await until('the stream to be away', async () => {
        const s = await archiveOf(other.id);
        if (s.progress.error) throw new Error(s.progress.error);
        return s.archive?.state === 'archived' && !s.progress.step;
      });
      expect(fs.existsSync(idle)).toBe(false);
      expect((await api.post(`/api/projects/${other.id}/revive`)).status).toBe(
        202,
      );
      await until('the stream to be back', async () => {
        const s = await archiveOf(other.id);
        if (s.progress.error) throw new Error(s.progress.error);
        return !s.archive && !s.progress.step;
      });
    };
    // away and back twice before a word is said to its agent
    await cycle();
    expect(git(idle, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(
      'other/idle',
    );
    expect(git(idle, 'rev-parse', 'HEAD').trim()).toBe(at);
    expect(git(remote, 'branch', '--list', 'other/*').trim()).toBe(''); // never pushed: it held nothing
    await cycle();
    process.env.AGENT_MANAGER_FAKE_NO_HOOKS = '1';
    try {
      await turn(a.id, 'where were we');
      await turn(a.id, 'and now');
    } finally {
      delete process.env.AGENT_MANAGER_FAKE_NO_HOOKS;
    }
    const said = (await itemsOf(a.id))
      .filter((i) => i.kind === 'user')
      .map((i) => i.text as string)
      .slice(-2);
    expect(said[0]).toMatch(
      /^\[From the manager, not from a person\]\nThis stream was put away on \d{4}-\d\d-\d\d and brought back on [^]*\n\nwhere were we$/,
    );
    expect(said[0]!.split('This stream was put away on ')).toHaveLength(2); // the last absence, once
    expect(said[0]).toContain('- thing: was at ');
    expect(said[1]).toBe('and now');

    const bare = (await api.post('/api/streams', { name: 'bare' })).body
      .project;
    expect(
      (await api.post(`/api/projects/${bare.id}/archive`, {})).status,
    ).toBe(202);
    const gone = await until('the stream to be away', async () => {
      const s = await archiveOf(bare.id);
      return s.archive?.state === 'archived' && !s.progress.step ? s : null;
    });
    expect(gone.progress.done).toBe(
      'put away by admin: 0 clones removed (under 1 MB), 0 of 0 agents compacted',
    );
  }, 60000);
});
