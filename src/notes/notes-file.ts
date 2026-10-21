import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * A project's notes: the person's small actionable items about it, written
 * as they come up, often while an agent works on something else. Not
 * features: no report, no status beyond done, no gate per item. One file
 * per note under the manager's data directory, `notes/<project id>/<id>.md`,
 * and deliberately not in the repository: a note added while an agent
 * works would otherwise land in its next commit, and a tick would dirty
 * its tree mid-feature. Agents reach them through `am notes`.
 *
 *     ---
 *     date: 2026-10-21
 *     done: false
 *     ---
 *     show the stats of the selected weapon
 *
 *     In the right panel, the same numbers the hangar shows.
 *
 * The id is the file name; the first line of the text is the title, the
 * rest its body. One file per note, so adding never touches a file being
 * edited and ticking is a one-line change in one small file.
 */

export interface NoteItem {
  id: string;
  done: boolean;
  /** YYYY-MM-DD of when it was written. */
  date: string;
  /** The first line. */
  title: string;
  /** The rest; empty when there is none. */
  body: string;
}

const ID_RE = /^[a-z0-9]{4,12}$/;

export function parseNote(id: string, text: string): NoteItem {
  const t = text.replace(/\r\n/g, '\n');
  let date = '';
  let done = false;
  let rest = t;
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(t);
  if (m) {
    for (const line of m[1]!.split('\n')) {
      const kv = /^(\w+):\s*(.*)$/.exec(line);
      if (!kv) continue;
      if (kv[1] === 'date') date = kv[2]!.trim();
      if (kv[1] === 'done') done = kv[2]!.trim() === 'true';
    }
    rest = t.slice(m[0].length);
  }
  const { title, body } = splitText(rest);
  return { id, done, date, title, body };
}

export function formatNote(it: NoteItem): string {
  return `---\ndate: ${it.date}\ndone: ${it.done}\n---\n${it.title}${it.body ? `\n\n${it.body}` : ''}\n`;
}

export const newNoteId = (): string =>
  randomBytes(3).toString('hex').slice(0, 5);
export const today = (): string => new Date().toISOString().slice(0, 10);

/** Splits what a person typed into the first line and the rest. */
export function splitText(text: string): { title: string; body: string } {
  const t = text.replace(/\r\n/g, '\n').trim();
  const nl = t.indexOf('\n');
  if (nl < 0) return { title: t, body: '' };
  return {
    title: t.slice(0, nl).trim(),
    body: t
      .slice(nl + 1)
      .replace(/^\n+/, '')
      .trimEnd(),
  };
}

/** The directory is the base itself: `<dataDir>/notes/<project id>`, handed in by the service. */
export const notesDir = (base: string): string => base;
export const notePath = (base: string, id: string): string =>
  path.join(base, `${id}.md`);

/** Every note, open first, then by date and id; a missing directory is no notes. */
export async function readNotes(repoPath: string): Promise<NoteItem[]> {
  let names: string[];
  try {
    names = await fs.readdir(notesDir(repoPath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const items: NoteItem[] = [];
  for (const n of names) {
    if (!n.endsWith('.md')) continue;
    const id = n.slice(0, -3);
    if (!ID_RE.test(id)) continue;
    try {
      items.push(
        parseNote(
          id,
          await fs.readFile(path.join(notesDir(repoPath), n), 'utf8'),
        ),
      );
    } catch {
      /* removed meanwhile */
    }
  }
  return items.sort(
    (a, b) =>
      Number(a.done) - Number(b.done) ||
      a.date.localeCompare(b.date) ||
      a.id.localeCompare(b.id),
  );
}

export async function readNote(
  repoPath: string,
  id: string,
): Promise<NoteItem | null> {
  if (!ID_RE.test(id)) return null;
  try {
    return parseNote(id, await fs.readFile(notePath(repoPath, id), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Writes one note atomically (temp file and rename); the directory is made the first time. */
export async function writeNote(repoPath: string, it: NoteItem): Promise<void> {
  await fs.mkdir(notesDir(repoPath), { recursive: true });
  const p = notePath(repoPath, it.id);
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(tmp, formatNote(it));
  await fs.rename(tmp, p);
}

export async function removeNote(
  repoPath: string,
  id: string,
): Promise<boolean> {
  if (!ID_RE.test(id)) return false;
  try {
    await fs.unlink(notePath(repoPath, id));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** The newest mtime under the directory, the directory's own included, for a poll. */
export async function notesMtime(repoPath: string): Promise<number> {
  let newest = 0;
  try {
    const dir = notesDir(repoPath);
    newest = (await fs.stat(dir)).mtimeMs;
    for (const n of await fs.readdir(dir)) {
      if (!n.endsWith('.md')) continue;
      try {
        newest = Math.max(newest, (await fs.stat(path.join(dir, n))).mtimeMs);
      } catch {
        /* removed meanwhile */
      }
    }
  } catch {
    return 0;
  }
  return newest;
}
