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
  if (status === null) return null; // half an answer is no answer
  {
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

/** Parses `git`'s `--name-status -z` output (a status code, then one path, or two for a rename/copy). */
function parseNameStatusZ(text: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const t = text.split('\0');
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
  return files;
}

export interface CommitInfo {
  hash: string;
  subject: string;
  /** The git author name recorded on the commit. */
  author: string;
  /** Author time in milliseconds. */
  at: number;
}

/**
 * The most recent commits reachable from HEAD, newest first. With `since`
 * (a resolved commit hash), only the commits after it (`since..HEAD`);
 * `since` itself must already be validated by the caller. Null when the
 * directory is not a repository or git fails.
 */
export async function log(
  cwd: string,
  opts: { limit?: number; since?: string } = {},
): Promise<CommitInfo[] | null> {
  const args = [
    '--no-optional-locks',
    'log',
    `--max-count=${opts.limit ?? 100}`,
    '--format=%H%x1f%s%x1f%an%x1f%ct',
    '-z',
  ];
  if (opts.since) args.push(`${opts.since}..HEAD`);
  const out = await git(cwd, args);
  if (out === null) return null;
  const commits: CommitInfo[] = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const [hash, subject, author, ct] = rec.split('\x1f');
    commits.push({
      hash: hash!,
      subject: subject ?? '',
      author: author ?? '',
      at: Number(ct) * 1000,
    });
  }
  return commits;
}

/** The set of commit hashes in `base..end` (end defaults to HEAD); null on git failure. */
export async function commitsIn(
  cwd: string,
  base: string,
  end = 'HEAD',
): Promise<Set<string> | null> {
  const out = await git(cwd, [
    '--no-optional-locks',
    'rev-list',
    `${base}..${end}`,
  ]);
  if (out === null) return null;
  return new Set(
    out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** How many commits are in `base..end` (end defaults to HEAD); null on git failure. */
export async function countIn(
  cwd: string,
  base: string,
  end = 'HEAD',
): Promise<number | null> {
  const out = await git(cwd, [
    '--no-optional-locks',
    'rev-list',
    '--count',
    `${base}..${end}`,
  ]);
  if (out === null) return null;
  const n = Number(out.trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * The files a single commit changed against its first parent (a root
 * commit shows every file as added). Renames detected. Null on git
 * failure, including a hash that no longer exists.
 */
export async function commitFiles(
  cwd: string,
  hash: string,
): Promise<ChangedFile[] | null> {
  const out = await git(cwd, [
    '--no-optional-locks',
    'diff-tree',
    '--root',
    '-r',
    '-M',
    '--name-status',
    '-z',
    '--no-commit-id',
    hash,
  ]);
  if (out === null) return null;
  const files = parseNameStatusZ(out);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/** One commit's metadata (hash, subject, author, time), or null if it does not exist. */
export async function commitMeta(
  cwd: string,
  hash: string,
): Promise<CommitInfo | null> {
  const out = await git(cwd, [
    '--no-optional-locks',
    'show',
    '-s',
    '--format=%H%x1f%s%x1f%an%x1f%ct',
    hash,
  ]);
  if (out === null) return null;
  const [h, subject, author, ct] = out.replace(/\0$/, '').split('\x1f');
  if (!h) return null;
  return {
    hash: h.trim(),
    subject: subject ?? '',
    author: author ?? '',
    at: Number(ct) * 1000,
  };
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

/** Size of the blob at `base:path`, or null if it does not exist there. */
export async function sizeAt(
  cwd: string,
  base: string,
  path: string,
): Promise<number | null> {
  const out = await git(cwd, ['cat-file', '-s', `${base}:${path}`]);
  if (out === null) return null;
  const n = Number(out.trim());
  return Number.isFinite(n) ? n : null;
}
