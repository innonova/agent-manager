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
    // the clone in a home of its own: what would be removed is what is in there, and the remote is not
    fs.mkdirSync(path.join(root, 'home'));
    clone = path.join(root, 'home', 'clone');
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
      'its submodule sub has work of its own that is nowhere else, or could not be compared with its remote: commit and push it there first',
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

  it('does not take the clone’s own memory of the remote for news, nor let the look change a ref', async () => {
    // the clone follows main only, and is set up to prune tags: a fetch as it is set up would leave topic stale and delete the tag
    fs.writeFileSync(path.join(clone, 'b.txt'), 'b\n');
    git(clone, 'add', '-A');
    git(clone, 'checkout', '-q', '-b', 'topic');
    git(clone, 'commit', '-qm', 'b');
    git(clone, 'push', '-q', '-u', 'origin', 'topic');
    git(
      clone,
      'config',
      'remote.origin.fetch',
      '+refs/heads/main:refs/remotes/origin/main',
    );
    git(clone, 'config', 'fetch.prune', 'true');
    git(clone, 'config', 'fetch.pruneTags', 'true');
    git(clone, 'tag', 'mine');
    git(remote, 'branch', '-D', 'topic');
    const u = await look();
    expect(u.unpushed).toEqual([{ branch: 'topic', commits: 1, main: false }]);
    expect(u.refs).toEqual(['tags/mine']);
    expect(git(clone, 'tag', '--list').trim()).toBe('mine'); // still there
    expect(git(clone, 'rev-parse', 'origin/topic').trim()).toBe(u.head); // and so is what the clone remembered
    expect(u.unknown).toEqual([]);
  });

  it('looks at what is checked out whatever refs there are, and at what only a remembered branch holds', async () => {
    // a repository made in place, on no branch, with no branch left
    const lone = path.join(root, 'home', 'lone');
    fs.mkdirSync(lone);
    git(lone, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(lone, 'a.txt'), 'a\n');
    git(lone, 'add', '-A');
    git(lone, 'commit', '-qm', 'a');
    git(lone, 'checkout', '-q', '--detach');
    git(lone, 'branch', '-D', 'main');
    const l = await svc.unsaved({ name: 'lone', path: lone });
    expect(l).toMatchObject({ branch: null, detached: 1, unpushed: [] });
    expect(l.head).toMatch(/^[0-9a-f]{40}$/);

    // a commit nothing holds but the clone's memory of another remote's branch
    git(clone, 'checkout', '-q', '--detach');
    fs.writeFileSync(path.join(clone, 'z.txt'), 'z\n');
    git(clone, 'add', '-A');
    git(clone, 'commit', '-qm', 'z');
    git(clone, 'update-ref', 'refs/remotes/backup/z', 'HEAD');
    git(clone, 'checkout', '-q', 'main');
    const u = await look();
    expect(u.beyond).toHaveLength(1);
    expect(u.beyond[0]).toContain(
      'remotes/backup/z is the clone’s memory of a branch with 1 commit that origin does not have now and no local branch holds'.replace(
        '’',
        "'",
      ),
    );
  });

  it('takes an origin inside what goes with the clone for no other place, and says what it keeps of a submodule that is not checked out', async () => {
    const inside = path.join(root, 'home', 'inside.git');
    git(root, 'clone', '-q', '--bare', remote, inside);
    git(clone, 'remote', 'set-url', 'origin', inside);
    const u = await look();
    expect(u.fetched).toBe(false);
    expect(u.beyond).toEqual([
      `its origin (${inside}) is inside what would be removed with it: that is no other place for its commits`,
    ]);
    expect(u.unpushed).toEqual([{ branch: 'main', commits: 1, main: false }]);
    git(clone, 'remote', 'set-url', 'origin', remote);

    git(clone, 'submodule', 'add', '-q', remote, 'sub');
    git(clone, 'commit', '-qm', 'a submodule');
    git(clone, 'push', '-q', 'origin', 'HEAD:main');
    expect((await look()).beyond).toEqual([]);
    git(clone, 'submodule', 'deinit', '-q', '-f', 'sub');
    expect((await look()).beyond).toEqual([
      'it keeps the repository of a submodule that is not checked out (.git/modules/sub): what that holds is not looked at. Check it out again, or remove it if nothing there is wanted',
    ]);
  });

  it('knows what is not committed by what it is, not by its name', async () => {
    fs.writeFileSync(path.join(clone, 'notes.txt'), 'one\n');
    const first = (await look()).print;
    expect((await look()).print).toBe(first);
    fs.writeFileSync(path.join(clone, 'notes.txt'), 'one\nand more\n');
    const second = (await look()).print;
    expect(second).not.toBe(first);
    git(clone, 'stash', '-u');
    const stashed = (await look()).print;
    expect(stashed).not.toBe(second);
    fs.writeFileSync(path.join(clone, 'a.txt'), 'other work\n');
    git(clone, 'stash');
    git(clone, 'stash', 'drop', 'stash@{1}');
    expect((await look()).stashes).toBe(1); // one stash as before, and not the same one
    expect((await look()).print).not.toBe(stashed);
  });

  it('leaves what the clone remembers of the remote alone while it asks, and does not take a branch that went for one that is there', async () => {
    // origin/topic remembers commits that the remote has rewritten since, and no local branch has them
    fs.writeFileSync(path.join(clone, 'b.txt'), 'b\n');
    git(clone, 'add', '-A');
    git(clone, 'checkout', '-q', '-b', 'topic');
    git(clone, 'commit', '-qm', 'the first take');
    git(clone, 'push', '-q', '-u', 'origin', 'topic');
    const first = git(clone, 'rev-parse', 'HEAD').trim();
    git(clone, 'checkout', '-q', 'main');
    git(clone, 'branch', '-D', 'topic');
    const other = path.join(root, 'other');
    git(root, 'clone', '-q', remote, other);
    git(other, 'checkout', '-q', 'topic');
    git(other, 'commit', '-q', '--amend', '-m', 'the second take');
    git(other, 'push', '-q', '--force', 'origin', 'topic');
    const u = await look();
    expect(git(clone, 'rev-parse', 'origin/topic').trim()).toBe(first); // not moved by the look
    expect(u.beyond).toHaveLength(1);
    expect(u.beyond[0]).toContain(
      "remotes/origin/topic is the clone's memory of a branch with 1 commit that origin does not have now",
    );
  });

  it('counts what is staged as part of what is not committed', async () => {
    fs.writeFileSync(path.join(clone, 'a.txt'), 'a\nmore\n');
    const before = (await look()).print;
    // more work goes into the index alone: the file on disk is as it was
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: clone,
      input: 'a\nstaged and nowhere else\n',
      encoding: 'utf8',
    }).trim();
    git(clone, 'update-index', '--cacheinfo', `100644,${blob},a.txt`);
    const after = await look();
    expect(after.uncommitted).toEqual(['a.txt']);
    expect(after.print).not.toBe(before);
  });

  it('takes a file: address inside what goes with the clone for no other place either', async () => {
    git(clone, 'remote', 'set-url', 'origin', `file://${clone}`);
    const u = await look();
    expect(u.fetched).toBe(false);
    expect(u.beyond[0]).toContain('is inside what would be removed with it');
  });
});
