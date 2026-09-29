import fs from 'node:fs';
import path from 'node:path';
import type { Repo } from './projects.service.js';

/**
 * A VS Code workspace file per project, kept beside its repositories: the
 * file is `<name>.code-workspace` in the parent of the primary repository
 * (for a `~/projects/<repo>` layout, `~/projects/<name>.code-workspace`),
 * and a client opens it over Remote SSH from a link. The manager owns the
 * `folders` list only: settings, extensions or anything else a person
 * put in the file are kept, and a file it cannot parse is left alone.
 */
export function workspacePath(name: string, repos: Repo[]): string {
  const safe = name.replace(/[\\/\0]/g, '-').trim() || 'project';
  return path.join(path.dirname(repos[0].path), `${safe}.code-workspace`);
}

/** The folders as the workspace should list them. */
export function workspaceFolders(
  repos: Repo[],
): { name: string; path: string }[] {
  return repos.map((r) => ({ name: r.name, path: r.path }));
}

/**
 * Writes or updates the file; returns what happened, for the log. Nothing
 * is written when the folders already match, so a person's editor does
 * not see the file change under it on every project edit.
 */
export function writeWorkspace(
  name: string,
  repos: Repo[],
): { file: string; result: 'written' | 'unchanged' | 'unparseable' } {
  const file = workspacePath(name, repos);
  const folders = workspaceFolders(repos);
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return { file, result: 'unparseable' };
      existing = parsed as Record<string, unknown>;
    } catch {
      return { file, result: 'unparseable' };
    }
    if (JSON.stringify(existing.folders) === JSON.stringify(folders))
      return { file, result: 'unchanged' };
  }
  const next = { ...existing, folders };
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return { file, result: 'written' };
}
