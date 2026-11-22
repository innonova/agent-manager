import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StreamsService } from './streams.service.js';

/**
 * What of a clone is nowhere else: the answer that licenses its removal
 * when a stream is put away. The cases a look at branches and `git
 * status` alone would miss.
 */
describe('what of a clone is nowhere else', () => {
  const svc = new StreamsService({} as never, {} as never, {} as never);
  let root: string;
  let remote: string;
  let clone: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.invalid',
        '-c',
        'protocol.file.allow=always',
        ...args,
      ],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  const look = () => svc.unsaved({ name: 'thing', path: clone });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'unsaved-'));
    remote = path.join(root, 'remote.git');
    fs.mkdirSync(remote);
    git(remote, 'init', '-q', '--bare', '-b', 'main');
    const seed = path.join(root, 'seed');
    git(root, 'clone', '-q', remote, seed);
    fs.writeFileSync(path.join(seed, 'a.txt'), 'a\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'a');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    clone = path.join(root, 'clone');
    git(root, 'clone', '-q', remote, clone);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('finds nothing in a fresh clone, and says where it stands', async () => {
    const u = await look();
    expect(u).toMatchObject({
      source: remote,
      fetched: true,
      branch: 'main',
      main: { ref: 'origin/main' },
      unpushed: [],
      detached: 0,
      stashes: 0,
      uncommitted: [],
      refs: [],
      beyond: [],
      unknown: [],
    });
    expect(u.head).toBe(u.main!.sha);
  });

  it('counts commits against the remote as it is now, on whatever holds them', async () => {
    fs.writeFileSync(path.join(clone, 'b.txt'), 'b\n');
    git(clone, 'add', '-A');
    git(clone, 'commit', '-qm', 'b');
    git(clone, 'branch', 'topic');
    git(clone, 'push', '-q', 'origin', 'topic');
    // on the remote under one name is somewhere else, whichever local branches hold it too
    expect((await look()).unpushed).toEqual([]);
    // somebody deletes the branch on the remote: the clone's memory of it is not a place the commit is
    git(remote, 'branch', '-D', 'topic');
    expect((await look()).unpushed).toEqual([
      { branch: 'main', commits: 1, main: true },
      { branch: 'topic', commits: 1, main: false },
    ]);
    // on no branch at all
    git(clone, 'checkout', '-q', '--detach');
    fs.writeFileSync(path.join(clone, 'c.txt'), 'c\n');
    git(clone, 'add', '-A');
    git(clone, 'commit', '-qm', 'c');
    const u = await look();
    expect(u.branch).toBeNull();
    expect(u.detached).toBe(1);
  });

  it('sees stashes, notes and tags, which no branch holds', async () => {
    fs.writeFileSync(path.join(clone, 'a.txt'), 'changed\n');
    git(clone, 'stash');
    git(clone, 'notes', 'add', '-m', 'remember this');
    git(clone, 'tag', 'light');
    const u = await look();
    expect(u.stashes).toBe(1);
    expect(u.refs.sort()).toEqual(['notes/commits', 'tags/light']);
    // a tag the remote has, as it is here, is somewhere else
    git(clone, 'push', '-q', 'origin', 'light');
    expect((await look()).refs).toEqual(['notes/commits']);
  });

  it('does not vouch for linked worktrees or for a submodule with work of its own', async () => {
    git(
      clone,
      'worktree',
      'add',
      '-q',
      path.join(root, 'elsewhere'),
      '-b',
      'wt',
    );
    const w = await look();
    expect(w.beyond).toHaveLength(1);
    expect(w.beyond[0]).toContain(
      `it has linked worktrees (${path.join(root, 'elsewhere')})`,
    );
    git(clone, 'worktree', 'remove', path.join(root, 'elsewhere'));
    git(clone, 'branch', '-D', 'wt');

    git(clone, 'submodule', 'add', '-q', remote, 'sub');
    git(clone, 'commit', '-qm', 'a submodule');
    git(clone, 'push', '-q', 'origin', 'HEAD:main');
    expect((await look()).beyond).toEqual([]); // clean, and all of it on its remote
    fs.writeFileSync(path.join(clone, 'sub', 'own.txt'), 'x\n');
    git(path.join(clone, 'sub'), 'add', '-A');
    git(path.join(clone, 'sub'), 'commit', '-qm', 'only here');
    const u = await look();
    expect(u.beyond).toEqual([
      'its submodule sub has work of its own that is nowhere else: commit and push it there first',
    ]);
  });

  it('says what it could not find out instead of finding nothing', async () => {
    fs.writeFileSync(path.join(clone, '.git', 'index'), 'not an index');
    const u = await look();
    expect(
      u.unknown.some((q) => q.startsWith('which files are not committed (')),
    ).toBe(true);
    // a repository made in place has no remote: everything in it is only here
    const lone = path.join(root, 'lone');
    fs.mkdirSync(lone);
    git(lone, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(lone, 'a.txt'), 'a\n');
    git(lone, 'add', '-A');
    git(lone, 'commit', '-qm', 'a');
    const l = await svc.unsaved({ name: 'lone', path: lone });
    expect(l.source).toBeNull();
    expect(l.unpushed).toEqual([{ branch: 'main', commits: 1, main: false }]);
  });
});
