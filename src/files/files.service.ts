import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
}

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

  /** Resolves a client path inside the project; returns the absolute path and the normalised relative one. */
  resolve(
    projectId: string,
    rel: unknown,
  ): { abs: string; rel: string; root: string } {
    const root = this.projects.get(projectId).path;
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
    return { abs: path.join(root, clean), rel: clean, root };
  }

  async list(
    projectId: string,
    rel: unknown,
  ): Promise<{ path: string; entries: DirEntry[] }> {
    const { abs, rel: clean } = this.resolve(projectId, rel);
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
            };
        } catch {
          /* dangling symlink or vanished entry: reported as is */
        }
        return { name: d.name, path: p, type, size, mtime };
      }),
    );
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
    const { abs, rel: clean } = this.resolve(projectId, rel);
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
