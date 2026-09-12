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
];
export const FEATURES_DIR = 'features';
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;
export function isSlug(s) {
    return typeof s === 'string' && SLUG_RE.test(s);
}
function split(text) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    if (!m)
        return { front: {}, body: text };
    let front;
    try {
        front = YAML.parse(m[1]) ?? {};
    }
    catch {
        front = {};
    }
    return {
        front: typeof front === 'object' && front !== null && !Array.isArray(front)
            ? front
            : {},
        body: m[2],
    };
}
export function parseFeature(slug, filePath, text, mtime) {
    const { front, body } = split(text);
    const { title, status, priority, profile, dependsOn, ...extra } = front;
    const st = FEATURE_STATUSES.includes(status)
        ? status
        : 'planned';
    const pr = typeof priority === 'number' && Number.isFinite(priority)
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
        path: filePath,
        title: typeof title === 'string' && title.trim()
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
export function serializeFeature(f) {
    const front = {
        title: f.title,
        status: f.status,
        priority: f.priority,
    };
    if (f.profile)
        front.profile = f.profile;
    if (f.dependsOn.length)
        front.dependsOn = f.dependsOn;
    Object.assign(front, f.extra);
    return `---\n${YAML.stringify(front).trimEnd()}\n---\n\n${f.body.replace(/\s+$/, '')}\n`;
}
export async function readFeatures(projectRoot) {
    const dir = path.join(projectRoot, FEATURES_DIR);
    let names;
    try {
        names = await fs.readdir(dir);
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return [];
        throw err;
    }
    const out = [];
    for (const name of names) {
        if (!name.endsWith('.md'))
            continue;
        const slug = name.slice(0, -3);
        if (!isSlug(slug))
            continue;
        const p = path.join(dir, name);
        try {
            const [text, st] = await Promise.all([
                fs.readFile(p, 'utf8'),
                fs.stat(p),
            ]);
            out.push(parseFeature(slug, path.posix.join(FEATURES_DIR, name), text, st.mtimeMs));
        }
        catch {
        }
    }
    return out;
}
export async function readFeature(projectRoot, slug) {
    if (!isSlug(slug))
        return null;
    const p = path.join(projectRoot, FEATURES_DIR, `${slug}.md`);
    try {
        const [text, st] = await Promise.all([fs.readFile(p, 'utf8'), fs.stat(p)]);
        return parseFeature(slug, path.posix.join(FEATURES_DIR, `${slug}.md`), text, st.mtimeMs);
    }
    catch {
        return null;
    }
}
export async function writeFeature(projectRoot, f) {
    const dir = path.join(projectRoot, FEATURES_DIR);
    await fs.mkdir(dir, { recursive: true });
    const p = path.join(dir, `${f.slug}.md`);
    const tmp = `${p}.tmp`;
    await fs.writeFile(tmp, serializeFeature(f));
    await fs.rename(tmp, p);
}
//# sourceMappingURL=feature-file.js.map