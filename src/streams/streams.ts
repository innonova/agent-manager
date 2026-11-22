import fs from 'node:fs';
import path from 'node:path';

/**
 * A stream: a unit of work that is not tied to a repository (see
 * `docs/streams.md`). It has a folder of its own in the store, one git
 * repository shared by all streams, for what it knows and decides
 * (instructions, features, docs); and a home, a plain directory where
 * its agents start, with the folder linked in and the stream's own
 * clones of the repositories it works on beside it:
 *
 *   <streams>/.store/<name>/      AGENTS.md, features/, docs/
 *   <streams>/<name>/             the home; not a repository
 *     stream -> the folder
 *     AGENTS.md, CLAUDE.md -> stream/AGENTS.md
 *     <repository>/               a clone
 *
 * This file is the layout and nothing else: no database, no git.
 */

/** A stream's name is a directory name twice over and part of branch names: lower case, digits and hyphens. */
export const STREAM_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The link in a home that leads to the stream's folder, and the name the folder goes by where it stands in for a repository. */
export const FOLDER_LINK = 'stream';

/** The stream's instruction file, under the name the vendors agree on least badly; `CLAUDE.md` in the home links to it. */
export const INSTRUCTIONS = 'AGENTS.md';

export function streamFolder(storeDir: string, name: string): string {
  return path.join(storeDir, name);
}

export function streamHome(streamsDir: string, name: string): string {
  return path.join(streamsDir, name);
}

/** What a new stream's instruction file says: its name, what it is for in the words it was started with, and nothing the harness note already says. */
export function instructionsTemplate(name: string, purpose: string): string {
  return [
    `# ${name}`,
    '',
    purpose.trim() ||
      '_What this stream is for, and what a good result looks like, is not written yet._',
    '',
    '## How this stream works',
    '',
    '_Whatever is true of this work and of no single repository: how it finishes work, who to ask, what is decided. A repository keeps its own commands, gate and hard rules in its own instruction file._',
    '',
  ].join('\n');
}

/**
 * Makes the home and its links, and mends them: a link that is missing
 * is made, one that leads elsewhere or a real file in its place is left
 * alone (somebody put it there). Relative links, so a streams directory
 * that moves as a whole keeps working.
 */
export function linkHome(home: string, folder: string): void {
  fs.mkdirSync(home, { recursive: true });
  const link = (name: string, target: string) => {
    const at = path.join(home, name);
    try {
      fs.lstatSync(at);
    } catch {
      fs.symlinkSync(target, at);
    }
  };
  link(FOLDER_LINK, path.relative(home, folder));
  link(INSTRUCTIONS, path.join(FOLDER_LINK, INSTRUCTIONS));
  link('CLAUDE.md', path.join(FOLDER_LINK, INSTRUCTIONS));
}

/**
 * The stream's clones: the directories in its home that are git
 * repositories. The disk is the record: a clone made by `am use` and
 * one an agent made with `git clone` are the same thing, and one that
 * was removed is gone without anybody being told.
 */
export function clonesIn(home: string): { name: string; path: string }[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (e) =>
        e.isDirectory() && // not the link to the folder, which is in the store's repository
        !e.name.startsWith('.') && // nor a clone still being made beside its place
        fs.existsSync(path.join(home, e.name, '.git')),
    )
    .map((e) => ({ name: e.name, path: path.join(home, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** What a repository in the registry is called: a directory name in a home. */
export const REPOSITORY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
