import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { NotRegularFileError, readRegular } from '../util/read-regular.js';

export const FEATURE_STATUSES = [
  'planned',
  'in-progress',
  'review',
  'blocked',
  'done',
] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

export interface FeatureFile {
  slug: string;
  /** The repo (by name) the file lives in. */
  repo: string;
  /** `<repo>/features/<slug>.md`. */
  path: string;
  title: string;
  status: FeatureStatus;
  priority: number;
  dependsOn: string[];
  /** The spec, followed by `## Report` and `## Response` sections as the work proceeds. */
  body: string;
  /** Other frontmatter keys, kept verbatim. */
  extra: Record<string, unknown>;
  mtime: number;
}

export const FEATURES_DIR = 'features';
/** A feature file larger than this is not a feature file. */
export const MAX_FEATURE_BYTES = 2 * 1024 * 1024;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export function isSlug(s: unknown): s is string {
  return typeof s === 'string' && SLUG_RE.test(s);
}

/** `key: value` lines as people write them, for frontmatter YAML refuses; quotes stripped, `[a, b]` and `a, b` as lists for dependsOn. */
function plainKeyValues(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const raw of text.split(/\r?\n/)) {
    const i = raw.indexOf(':');
    if (i <= 0) continue;
    const key = raw.slice(0, i).trim();
    let value: unknown = raw.slice(i + 1).trim();
    if (typeof value === 'string' && /^(["']).*\1$/.test(value))
      value = value.slice(1, -1);
    if (key === 'dependsOn' && typeof value === 'string')
      value = value
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    if (key === 'priority' && typeof value === 'string' && /^\d+$/.test(value))
      value = Number(value);
    out[key] = value;
  }
  return out;
}

/** Splits `---\n...\n---\n` frontmatter from the body; tolerant of files without any. */
function split(text: string): { front: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { front: {}, body: text };
  let front: unknown;
  try {
    front = YAML.parse(m[1]) ?? {};
  } catch {
    // Not YAML to the letter: a title with ": " in it is the usual case
    // ("the UI as a reading app: hierarchy, ..."), which YAML refuses and
    // which silently made every such feature `planned` with no title,
    // no range and no run (learnings #47). Read it as people write it:
    // one `key: value` per line, the first colon the separator.
    front = plainKeyValues(m[1]);
  }
  return {
    front:
      typeof front === 'object' && front !== null && !Array.isArray(front)
        ? (front as Record<string, unknown>)
        : {},
    body: m[2],
  };
}

export function parseFeature(
  slug: string,
  repo: string,
  filePath: string,
  text: string,
  mtime: number,
): FeatureFile {
  const { front, body } = split(text);
  const { title, status, priority, dependsOn, ...extra } = front;
  const st = FEATURE_STATUSES.includes(status as FeatureStatus)
    ? (status as FeatureStatus)
    : 'planned';
  const pr =
    typeof priority === 'number' && Number.isFinite(priority)
      ? priority
      : typeof priority === 'string' && /^\d+$/.test(priority)
        ? Number(priority)
        : 100;
  const deps = Array.isArray(dependsOn)
    ? dependsOn.filter(isSlug)
    : typeof dependsOn === 'string' && isSlug(dependsOn)
      ? [dependsOn]
      : [];
  const firstHeading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  return {
    slug,
    repo,
    path: filePath,
    title:
      typeof title === 'string' && title.trim()
        ? title.trim()
        : (firstHeading ?? slug),
    status: st,
    priority: pr,
    dependsOn: deps,
    body: body.replace(/^\r?\n/, ''),
    extra,
    mtime,
  };
}

export function serializeFeature(
  f: Pick<
    FeatureFile,
    'title' | 'status' | 'priority' | 'dependsOn' | 'body' | 'extra'
  >,
): string {
  const front: Record<string, unknown> = {
    title: f.title,
    status: f.status,
    priority: f.priority,
  };
  if (f.dependsOn.length) front.dependsOn = f.dependsOn;
  Object.assign(front, f.extra);
  return `---\n${YAML.stringify(front).trimEnd()}\n---\n\n${f.body.replace(/\s+$/, '')}\n`;
}

export async function readFeatures(repo: {
  name: string;
  path: string;
}): Promise<FeatureFile[]> {
  const dir = path.join(repo.path, FEATURES_DIR);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: FeatureFile[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const slug = name.slice(0, -3);
    if (!isSlug(slug)) continue;
    const p = path.join(dir, name);
    try {
      const read = await readRegular(p, MAX_FEATURE_BYTES);
      if (!read || read.truncated) continue;
      out.push(
        parseFeature(
          slug,
          repo.name,
          path.posix.join(repo.name, FEATURES_DIR, name),
          read.buf.toString('utf8'),
          read.mtimeAfter,
        ),
      );
    } catch {
      /* vanished, unreadable or not a regular file: skip */
    }
  }
  return out;
}

export async function readFeature(
  repo: { name: string; path: string },
  slug: string,
): Promise<FeatureFile | null> {
  if (!isSlug(slug)) return null;
  const p = path.join(repo.path, FEATURES_DIR, `${slug}.md`);
  try {
    const read = await readRegular(p, MAX_FEATURE_BYTES);
    if (!read || read.truncated) return null;
    return parseFeature(
      slug,
      repo.name,
      path.posix.join(repo.name, FEATURES_DIR, `${slug}.md`),
      read.buf.toString('utf8'),
      read.mtimeAfter,
    );
  } catch {
    return null;
  }
}

/** Rewrites a feature file with new frontmatter values, keeping the body and unknown keys. */
/** Creates the file, refusing if one appeared meanwhile (EEXIST). */
export async function createFeatureFile(
  repoPath: string,
  f: FeatureFile,
): Promise<void> {
  const dir = path.join(repoPath, FEATURES_DIR);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${f.slug}.md`), serializeFeature(f), {
    flag: 'wx',
  });
}

/**
 * Read, modify, write: `fn` gets the current file and returns the new one.
 * If the file changed on disk between the read and the moment we would
 * replace it (an agent appending its report), the write is retried on the
 * fresh content; after a few rounds it gives up rather than clobber.
 */
export async function modifyFeature(
  repo: { name: string; path: string },
  slug: string,
  fn: (current: FeatureFile) => FeatureFile | Promise<FeatureFile>,
): Promise<FeatureFile | null> {
  const p = path.join(repo.path, FEATURES_DIR, `${slug}.md`);
  for (let attempt = 0; attempt < 5; attempt++) {
    // One coherent version: the descriptor's mtime must be the same before
    // and after the read, or something wrote meanwhile and we read again.
    let read: Awaited<ReturnType<typeof readRegular>>;
    try {
      read = await readRegular(p, MAX_FEATURE_BYTES);
    } catch (err) {
      if (err instanceof NotRegularFileError) return null;
      throw err;
    }
    if (!read || read.truncated) return null;
    if (read.mtimeBefore !== read.mtimeAfter) continue;
    const mtime = read.mtimeAfter;
    const current = parseFeature(
      slug,
      repo.name,
      path.posix.join(repo.name, FEATURES_DIR, `${slug}.md`),
      read.buf.toString('utf8'),
      mtime,
    );
    const next = await fn(current);
    const tmp = `${p}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
    await fs.writeFile(tmp, serializeFeature(next));
    const st = await fs.stat(p).catch(() => null);
    if (!st || st.mtimeMs !== current.mtime) {
      // someone wrote meanwhile: start over on what they wrote
      await fs.rm(tmp, { force: true });
      continue;
    }
    await fs.rename(tmp, p);
    return next;
  }
  throw new Error(`feature ${slug} keeps changing under us; not overwriting`);
}

export async function writeFeature(
  repoPath: string,
  f: FeatureFile,
): Promise<void> {
  const dir = path.join(repoPath, FEATURES_DIR);
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, `${f.slug}.md`);
  // Unique per write: two writers must not share a temporary file.
  const tmp = `${p}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmp, serializeFeature(f));
  await fs.rename(tmp, p);
}

/**
 * The last `## Report` section of a feature's body, heading included:
 * what the agent said about the round that just ended. Null when the
 * feature has no report yet.
 */
export function lastReport(body: string): string | null {
  const heads = [...body.matchAll(/^## Report\b.*$/gm)];
  const last = heads[heads.length - 1];
  if (!last) return null;
  const from = last.index!;
  // up to the next section of either kind, else the end of the body
  const after = body.slice(from + last[0].length);
  const next = /^## (?:Report|Response)\b/m.exec(after);
  const text = next ? after.slice(0, next.index) : after;
  return `${last[0]}${text}`.trim();
}
