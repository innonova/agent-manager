import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Claude Code's own record of a conversation: `~/.claude/projects/<cwd with
 * every separator as "-">/<conversation id>.jsonl`, one record per line,
 * which `--resume` continues from wherever it ends. Cutting it back to the
 * record before a prompt is what makes "withdraw my last message" real:
 * resumed, the agent has no memory of the prompt or anything after it.
 * The format is Anthropic's, not ours (`type: 'user'` records with the
 * prompt as `message.content`, a string or text blocks; tool results are
 * `user` records too, with `tool_result` blocks), so this reads as little
 * of it as it can and cuts only at a record boundary.
 */
export function conversationFile(cwd: string, conversationId: string): string {
  const dir = cwd.replace(/[\\/:]/g, '-');
  return path.join(
    os.homedir(),
    '.claude',
    'projects',
    dir,
    `${conversationId}.jsonl`,
  );
}

function promptText(record: unknown): string | null {
  const r = record as {
    type?: unknown;
    message?: { content?: unknown };
  } | null;
  if (!r || r.type !== 'user') return null;
  const c = r.message?.content;
  if (typeof c === 'string') return c;
  if (
    Array.isArray(c) &&
    c.length &&
    (c[0] as { type?: unknown }).type === 'text'
  )
    return String((c[0] as { text?: unknown }).text ?? '');
  return null; // a tool result, or something newer
}

/**
 * Cuts the file back to just before the last prompt whose text is `text`;
 * returns how many records went, 0 when no such prompt is there (the file
 * is then untouched). Written whole to a temp file and renamed.
 */
export function withdrawLastPrompt(
  file: string,
  text: string,
): { removed: number; kept: number } {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let cut = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec: unknown;
    try {
      rec = JSON.parse(lines[i]!);
    } catch {
      continue;
    }
    const t = promptText(rec);
    if (t !== null && t.trim() === text.trim()) {
      cut = i;
      break;
    }
  }
  if (cut < 0) return { removed: 0, kept: lines.length };
  const kept = lines.slice(0, cut);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '');
  fs.renameSync(tmp, file);
  return { removed: lines.length - cut, kept: kept.length };
}
