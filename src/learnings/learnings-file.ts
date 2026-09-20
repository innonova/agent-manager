/**
 * The learnings log's file format. One entry per section, a header line
 * the manager writes and a body the author wrote:
 *
 * ```
 * ## 2026-09-20 11:30 · agent-claude · run 9ae50a37 · feature run-log
 *
 * The run's spend read zero although its turns cost about $31.
 * ```
 *
 * Markdown, not a table: the file is the artifact a person reads and
 * curates, and it is diffable and legible without the manager. The cost
 * of that choice is that the body and the index share a syntax, which is
 * what `escapeBody` and the strict header grammar below are for: a body
 * line that would pass for a header is indented on the way in, so no
 * entry can split itself in two on the way out.
 */
export interface LearningEntry {
  /** Position in the file, counting from 1. The file is the index; a hand edit renumbers. */
  n: number;
  /** Unix ms, from the header's date and time (local, minute precision). */
  at: number;
  /** Who wrote it: a user's name, or an agent's `agent-<name>`. */
  by: string;
  /** What it points at, free text: a run id, a feature slug, a commit. */
  ref: string | null;
  text: string;
}

/** `## 2026-09-20 11:30 · someone` with optional ` · ref`. Anything else is body. */
const HEADER =
  /^## (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) · ([^·\n]+?)(?: · ([^\n]+))?$/;

/** Two digits, for a header's own date and time. */
const pad = (n: number) => String(n).padStart(2, '0');

export function headerOf(at: number, by: string, ref?: string | null): string {
  const d = new Date(at);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const who = by.replace(/[·\n]/g, ' ').trim() || 'unknown';
  const what = ref?.replace(/[\n]/g, ' ').trim();
  return `## ${stamp} · ${who}${what ? ` · ${what}` : ''}`;
}

/**
 * A body can say anything, including something that looks like a header.
 * Such a line is indented by one space: Markdown renders it the same and
 * the parser no longer sees an entry boundary where the author meant a
 * heading. Nothing else about the text is touched.
 */
export function escapeBody(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => (HEADER.test(line) ? ` ${line}` : line))
    .join('\n')
    .trim();
}

/** The text of one entry, ready to append to the file. */
export function renderEntry(
  at: number,
  by: string,
  ref: string | null,
  text: string,
): string {
  return `${headerOf(at, by, ref)}\n\n${escapeBody(text)}\n`;
}

/** Local date and time, as `headerOf` wrote them, back to unix ms. */
function parseStamp(date: string, time: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y!, m! - 1, d!, hh!, mm!).getTime();
}

/**
 * Every entry of the file, oldest first, numbered from 1. Anything before
 * the first header is ignored: a file someone put a title on still reads.
 */
export function parseLearnings(text: string): LearningEntry[] {
  const entries: LearningEntry[] = [];
  let current: LearningEntry | null = null;
  let body: string[] = [];
  const close = () => {
    if (current) {
      current.text = body.join('\n').trim();
      entries.push(current);
    }
    body = [];
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const m = HEADER.exec(line);
    if (m) {
      close();
      current = {
        n: entries.length + 1,
        at: parseStamp(m[1]!, m[2]!),
        by: m[3]!.trim(),
        ref: m[4]?.trim() || null,
        text: '',
      };
      continue;
    }
    if (current) body.push(line);
  }
  close();
  return entries;
}
