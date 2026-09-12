import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ProjectsService } from '../projects/projects.service.js';

export interface DirEntry {
  name: string;
  /** Path relative to the project root, POSIX separators. */
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
  mtime: number;
  /**
   * Matched by the repository's ignore rules (`git check-ignore`, so
   * `.gitignore`, `.git/info/exclude` and the global excludes all count).
   * `.git` itself is reported as ignored too, since it is not part of the
   * tree in any useful sense. Always false outside a git repository.
   */
  ignored: boolean;
  /**
   * Working-tree status from `git status` for the entry, or for a
   * directory the most significant status among its contents (conflict,
   * then modified, added, untracked), as VS Code tints folders. Null when
   * clean, ignored, or outside a repository.
   */
  status: EntryStatus | null;
}

export type EntryStatus =
  'modified' | 'added' | 'deleted' | 'untracked' | 'conflict';

export interface FileContent {
  path: string;
  size: number;
  mtime: number;
  /** Text content, empty when binary or truncated past the cap. */
  content: string;
  binary: boolean;
  truncated: boolean;
}

/** Files larger than this are not sent; the UI shows a notice instead. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Read-only access to a project's tree. Paths are relative to the project
 * root and `..` is rejected as a correctness rule; there is deliberately
 * no containment beyond that (see docs/design.md, principles).
 */
@Injectable()
export class FilesService {
  constructor(private readonly projects: ProjectsService) {}

  /**
   * Resolves a client path. The first segment names a repo of the project;
   * the rest is relative inside it. `..` is rejected as a correctness rule;
   * nothing else is contained (see docs/design.md, principles).
   */
  resolve(
    projectId: string,
    rel: unknown,
  ): { abs: string; rel: string; repo: string } | { root: true } {
    const project = this.projects.get(projectId);
    const raw = rel === undefined || rel === null ? '' : rel;
    if (typeof raw !== 'string')
      throw new BadRequestException('"path" must be a string');
    const normalised = path.posix
      .normalize(raw.replace(/\\/g, '/'))
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    if (
      normalised === '..' ||
      normalised.startsWith('../') ||
      normalised.includes('/../')
    )
      throw new BadRequestException('"path" may not leave the project');
    const clean = normalised === '.' ? '' : normalised;
    if (clean === '') return { root: true };
    const [repoName, ...rest] = clean.split('/');
    const repo = project.repos.find((r) => r.name === repoName);
    if (!repo)
      throw new NotFoundException(
        `no such repository in this project: ${repoName}`,
      );
    return { abs: path.join(repo.path, ...rest), rel: clean, repo: repo.name };
  }

  async list(
    projectId: string,
    rel: unknown,
  ): Promise<{ path: string; entries: DirEntry[] }> {
    const target = this.resolve(projectId, rel);
    if ('root' in target) {
      // The virtual root: one folder per repository.
      const project = this.projects.get(projectId);
      const entries = await Promise.all(
        project.repos.map(async (r): Promise<DirEntry> => {
          const st = await fs.stat(r.path).catch(() => null);
          return {
            name: r.name,
            path: r.name,
            type: 'dir',
            size: 0,
            mtime: st?.mtimeMs ?? 0,
            ignored: false,
            status: null,
          };
        }),
      );
      return { path: '', entries };
    }
    const { abs, rel: clean } = target;
    let names: import('node:fs').Dirent[];
    try {
      names = await fs.readdir(abs, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT')
        throw new NotFoundException(`no such directory: ${clean || '/'}`);
      if ((err as NodeJS.ErrnoException).code === 'ENOTDIR')
        throw new BadRequestException(`not a directory: ${clean}`);
      throw err;
    }
    const entries = await Promise.all(
      names.map(async (d): Promise<DirEntry> => {
        const p = clean ? `${clean}/${d.name}` : d.name;
        const type: DirEntry['type'] = d.isSymbolicLink()
          ? 'symlink'
          : d.isDirectory()
            ? 'dir'
            : d.isFile()
              ? 'file'
              : 'other';
        let size = 0;
        let mtime = 0;
        try {
          const st = await fs.stat(path.join(abs, d.name)); // follows symlinks
          size = st.size;
          mtime = st.mtimeMs;
          if (type === 'symlink')
            return {
              name: d.name,
              path: p,
              type: st.isDirectory() ? 'dir' : 'symlink',
              size,
              mtime,
              ignored: false,
              status: null,
            };
        } catch {
          /* dangling symlink or vanished entry: reported as is */
        }
        return {
          name: d.name,
          path: p,
          type,
          size,
          mtime,
          ignored: false,
          status: null,
        };
      }),
    );
    const entryNames = entries.map((e) => e.name);
    const [ignored, status] = await Promise.all([
      gitIgnored(abs, entryNames),
      gitStatus(abs, entryNames),
    ]);
    for (const e of entries) {
      e.ignored = ignored.has(e.name);
      e.status = status.get(e.name) ?? null;
    }
    entries.sort((a, b) =>
      (a.type === 'dir') === (b.type === 'dir')
        ? a.name.localeCompare(b.name)
        : a.type === 'dir'
          ? -1
          : 1,
    );
    return { path: clean, entries };
  }

  async read(projectId: string, rel: unknown): Promise<FileContent> {
    const target = this.resolve(projectId, rel);
    if ('root' in target) throw new BadRequestException('is a directory: /');
    const { abs, rel: clean } = target;
    let st: import('node:fs').Stats;
    try {
      st = await fs.stat(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT')
        throw new NotFoundException(`no such file: ${clean}`);
      throw err;
    }
    if (st.isDirectory())
      throw new BadRequestException(`is a directory: ${clean}`);
    const base = { path: clean, size: st.size, mtime: st.mtimeMs };
    if (st.size > MAX_FILE_BYTES)
      return { ...base, content: '', binary: false, truncated: true };
    const buf = await fs.readFile(abs);
    const head = buf.subarray(0, 8192);
    if (head.includes(0))
      return { ...base, content: '', binary: true, truncated: false };
    return {
      ...base,
      content: buf.toString('utf8'),
      binary: false,
      truncated: false,
    };
  }
}

/**
 * Which of `names` (entries of directory `dir`) git ignores. One
 * `git check-ignore` per listing, names on stdin. Exit code 1 means none
 * matched; 128 (not a repository) or a missing git means nothing is
 * ignored, which is the honest answer outside a repo.
 */
export function gitIgnored(dir: string, names: string[]): Promise<Set<string>> {
  const result = new Set<string>();
  if (names.includes('.git')) result.add('.git');
  const candidates = names.filter((n) => n !== '.git');
  if (candidates.length === 0) return Promise.resolve(result);
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      ['check-ignore', '-z', '--stdin'],
      { cwd: dir, timeout: 5000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        // 0: some matched, 1: none matched, anything else: not a repo, no git, timeout.
        if (!err || (err as { code?: number | string }).code === 1) {
          for (const n of String(stdout).split('\0')) if (n) result.add(n);
        }
        resolve(result);
      },
    );
    child.stdin?.on('error', () => {
      /* git exited before reading; the callback reports the outcome */
    });
    child.stdin?.end(candidates.join('\0') + '\0');
  });
}

const STATUS_RANK: Record<EntryStatus, number> = {
  untracked: 1,
  added: 2,
  deleted: 3,
  modified: 4,
  conflict: 5,
};

/** Porcelain v1 `XY` code to a status; `!!` (ignored) is not a status. */
function classify(xy: string): EntryStatus | null {
  if (xy === '??') return 'untracked';
  if (xy === '!!') return null;
  if (xy.includes('U') || xy === 'AA' || xy === 'DD') return 'conflict';
  const [x, y] = xy;
  if ('MTRC'.includes(y!) || 'MTRC'.includes(x!)) return 'modified';
  if (x === 'A') return 'added';
  if (x === 'D' || y === 'D') return 'deleted';
  return 'modified';
}

/**
 * Status of `names` (entries of directory `dir`), from one `git status`
 * limited to that subtree. Paths in porcelain output are relative to the
 * repository root, so the directory's own prefix is resolved first. An
 * entry that is itself a directory takes the highest-ranked status found
 * beneath it, with a deleted child counting as modified. Any failure
 * (not a repository, no git, timeout) means no status, not an error.
 */
export function gitStatus(
  dir: string,
  names: string[],
): Promise<Map<string, EntryStatus>> {
  const result = new Map<string, EntryStatus>();
  const wanted = new Set(names.filter((n) => n !== '.git'));
  if (wanted.size === 0) return Promise.resolve(result);
  const opts = { cwd: dir, timeout: 10000, maxBuffer: 64 * 1024 * 1024 };
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--show-prefix'], opts, (err, out) => {
      if (err) return resolve(result);
      const prefix = String(out).trim();
      execFile(
        'git',
        [
          '--no-optional-locks',
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
          '--',
          '.',
        ],
        opts,
        (err2, out2) => {
          if (err2) return resolve(result);
          const tokens = String(out2).split('\0');
          for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i]!;
            if (t.length < 4) continue;
            const xy = t.slice(0, 2);
            const p = t.slice(3);
            if (xy[0] === 'R' || xy[0] === 'C') i++; // the source path follows
            if (!p.startsWith(prefix)) continue;
            const rel = p.slice(prefix.length);
            const slash = rel.indexOf('/');
            const name = slash < 0 ? rel : rel.slice(0, slash);
            if (!wanted.has(name)) continue;
            let st = classify(xy);
            if (!st) continue;
            if (slash >= 0 && st === 'deleted') st = 'modified';
            const prev = result.get(name);
            if (!prev || STATUS_RANK[st] > STATUS_RANK[prev])
              result.set(name, st);
          }
          resolve(result);
        },
      );
    });
  });
}
