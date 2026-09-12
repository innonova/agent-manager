import { execFile } from 'node:child_process';

const OPTS = { timeout: 10000, maxBuffer: 64 * 1024 * 1024 } as const;

/** Runs git in `cwd`; resolves stdout, or null on any failure (not a repo, bad ref, timeout). */
export function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, ...OPTS }, (err, stdout) =>
      resolve(err ? null : String(stdout)),
    );
  });
}

export async function head(cwd: string): Promise<string | null> {
  const out = await git(cwd, ['rev-parse', '--verify', 'HEAD']);
  return out ? out.trim() : null;
}

/** Resolves a commit-ish to a full hash, or null if it does not exist here. */
export async function resolveCommit(
  cwd: string,
  ref: string,
): Promise<string | null> {
  if (!/^[A-Za-z0-9._~^/-]{1,200}$/.test(ref)) return null;
  const out = await git(cwd, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${ref}^{commit}`,
  ]);
  return out ? out.trim() : null;
}

export type ChangeStatus =
  'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

export interface ChangedFile {
  /** Relative to the repository root, POSIX. */
  path: string;
  status: ChangeStatus;
  oldPath?: string;
}

/**
 * Everything different between `base` and the working tree: committed
 * since, staged, unstaged, and untracked (ignored files excluded, as git
 * does). Renames are detected.
 */
export async function changedFiles(
  cwd: string,
  base: string,
): Promise<ChangedFile[] | null> {
  const diff = await git(cwd, [
    '--no-optional-locks',
    'diff',
    '--name-status',
    '-M',
    '-z',
    base,
    '--',
  ]);
  if (diff === null) return null;
  const files: ChangedFile[] = [];
  const t = diff.split('\0');
  for (let i = 0; i < t.length; i++) {
    const code = t[i]!;
    if (!code) continue;
    const kind = code[0];
    if (kind === 'R' || kind === 'C') {
      const oldPath = t[++i]!;
      const path = t[++i]!;
      files.push({ path, status: 'renamed', oldPath });
    } else {
      const path = t[++i]!;
      files.push({
        path,
        status: kind === 'A' ? 'added' : kind === 'D' ? 'deleted' : 'modified',
      });
    }
  }
  const status = await git(cwd, [
    '--no-optional-locks',
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--',
    '.',
  ]);
  if (status !== null) {
    const seen = new Set(files.map((f) => f.path));
    const s = status.split('\0');
    for (let i = 0; i < s.length; i++) {
      const line = s[i]!;
      if (line.length < 4) continue;
      const xy = line.slice(0, 2);
      const path = line.slice(3);
      if (xy[0] === 'R' || xy[0] === 'C') i++;
      if (xy === '??' && !seen.has(path))
        files.push({ path, status: 'untracked' });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/** The file's content at `base`, or null if it did not exist there. */
export async function showAt(
  cwd: string,
  base: string,
  path: string,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['show', `${base}:${path}`],
      { cwd, ...OPTS, encoding: 'buffer' },
      (err, stdout) => resolve(err ? null : (stdout as Buffer)),
    );
  });
}
