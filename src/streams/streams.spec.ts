import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clonesIn,
  instructionsTemplate,
  linkHome,
  REPOSITORY_NAME_RE,
  STREAM_NAME_RE,
  streamFolder,
  streamHome,
} from './streams.js';

describe("a stream's layout", () => {
  const dirs = () => {
    const streams = fs.mkdtempSync(path.join(os.tmpdir(), 'am-streams-'));
    const folder = streamFolder(path.join(streams, '.store'), 'tidy');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'AGENTS.md'), '# tidy\n');
    return { streams, folder, home: streamHome(streams, 'tidy') };
  };

  it('names streams so they can be a directory, a folder and a branch prefix', () => {
    for (const ok of ['tidy', 'fresh-ui', 'a', '2026-cleanup'])
      expect(STREAM_NAME_RE.test(ok)).toBe(true);
    for (const bad of [
      '',
      'Tidy',
      '-x',
      '.store',
      'a b',
      'a/b',
      'a_b',
      'x'.repeat(64),
    ])
      expect(STREAM_NAME_RE.test(bad)).toBe(false);
    expect(REPOSITORY_NAME_RE.test('agent-manager_2.x')).toBe(true);
    expect(REPOSITORY_NAME_RE.test('.git')).toBe(false);
  });

  it('links the folder and the instruction file into the home, relatively', () => {
    const { folder, home } = dirs();
    linkHome(home, folder);
    expect(fs.readlinkSync(path.join(home, 'stream'))).toBe('../.store/tidy');
    expect(fs.readlinkSync(path.join(home, 'AGENTS.md'))).toBe(
      'stream/AGENTS.md',
    );
    expect(fs.readFileSync(path.join(home, 'CLAUDE.md'), 'utf8')).toBe(
      '# tidy\n',
    );
  });

  it('mends a home without touching what somebody put there', () => {
    const { folder, home } = dirs();
    linkHome(home, folder);
    fs.rmSync(path.join(home, 'AGENTS.md'));
    fs.rmSync(path.join(home, 'CLAUDE.md'));
    fs.writeFileSync(path.join(home, 'CLAUDE.md'), 'my own\n');
    linkHome(home, folder);
    expect(fs.readlinkSync(path.join(home, 'AGENTS.md'))).toBe(
      'stream/AGENTS.md',
    );
    expect(fs.readFileSync(path.join(home, 'CLAUDE.md'), 'utf8')).toBe(
      'my own\n',
    );
  });

  it('finds the clones on the disk: directories that are repositories, and nothing else', () => {
    const { folder, home } = dirs();
    // the store is a repository: the link to the folder must not read as a clone
    fs.mkdirSync(path.join(path.dirname(folder), '.git'));
    fs.mkdirSync(path.join(folder, '.git')); // even if the folder itself had one
    linkHome(home, folder);
    expect(clonesIn(home)).toEqual([]);
    fs.mkdirSync(path.join(home, 'zeta', '.git'), { recursive: true });
    fs.mkdirSync(path.join(home, 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(home, 'alpha', '.git'), 'gitdir: elsewhere\n'); // a worktree's
    fs.mkdirSync(path.join(home, 'scratch'));
    fs.mkdirSync(path.join(home, '.zeta.cloning', '.git'), { recursive: true });
    // one still being made is not there yet
    expect(clonesIn(home).map((c) => c.name)).toEqual(['alpha', 'zeta']);
    expect(clonesIn(path.join(home, 'missing'))).toEqual([]);
  });

  it('starts an instruction file with the purpose, or says there is none yet', () => {
    expect(instructionsTemplate('tidy', ' Keep the shed in order. ')).toContain(
      '# tidy\n\nKeep the shed in order.\n\n## How this stream works',
    );
    expect(instructionsTemplate('tidy', '')).toContain('is not written yet');
  });
});
