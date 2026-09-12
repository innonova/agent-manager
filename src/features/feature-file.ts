import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

export const FEATURE_STATUSES = [
  'planned',
  'queued',
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
  profile: string | null;
  dependsOn: string[];
  body: string;
  /** Other frontmatter keys, kept verbatim. */
  extra: Record<string, unknown>;
  mtime: number;
}

export const FEATURES_DIR = 'features';
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export function isSlug(s: unknown): s is string {
  return typeof s === 'string' && SLUG_RE.test(s);
}

/** Splits `---\n...\n---\n` frontmatter from the body; tolerant of files without any. */
function split(text: string): { front: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { front: {}, body: text };
  let front: unknown;
  try {
    front = YAML.parse(m[1]) ?? {};
  } catch {
    front = {};
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
  const { title, status, priority, profile, dependsOn, ...extra } = front;
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
    profile: typeof profile === 'string' && profile ? profile : null,
    dependsOn: deps,
    body: body.replace(/^\r?\n/, ''),
    extra,
    mtime,
  };
}

export function serializeFeature(
  f: Pick<
    FeatureFile,
    'title' | 'status' | 'priority' | 'profile' | 'dependsOn' | 'body' | 'extra'
  >,
): string {
  const front: Record<string, unknown> = {
    title: f.title,
    status: f.status,
    priority: f.priority,
  };
  if (f.profile) front.profile = f.profile;
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
      const [text, st] = await Promise.all([
        fs.readFile(p, 'utf8'),
        fs.stat(p),
      ]);
      out.push(
        parseFeature(
          slug,
          repo.name,
          path.posix.join(repo.name, FEATURES_DIR, name),
          text,
          st.mtimeMs,
        ),
      );
    } catch {
      /* vanished or unreadable: skip */
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
    const [text, st] = await Promise.all([fs.readFile(p, 'utf8'), fs.stat(p)]);
    return parseFeature(
      slug,
      repo.name,
      path.posix.join(repo.name, FEATURES_DIR, `${slug}.md`),
      text,
      st.mtimeMs,
    );
  } catch {
    return null;
  }
}

/** Rewrites a feature file with new frontmatter values, keeping the body and unknown keys. */
export async function writeFeature(
  repoPath: string,
  f: FeatureFile,
): Promise<void> {
  const dir = path.join(repoPath, FEATURES_DIR);
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, `${f.slug}.md`);
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, serializeFeature(f));
  await fs.rename(tmp, p);
}
