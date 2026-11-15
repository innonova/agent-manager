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
 * prompt as `message.content`, a string or text blocks; a message taken
 * during a turn as an `attachment` record), so this reads as little of it
 * as it can and cuts only at a record boundary.
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

function firstText(c: unknown): string | null {
  if (typeof c === 'string') return c;
  if (
    Array.isArray(c) &&
    c.length &&
    (c[0] as { type?: unknown }).type === 'text'
  )
    return String((c[0] as { text?: unknown }).text ?? '');
  return null;
}

/**
 * The text of a record that is a message from outside, null for anything
 * else: a `user` record with the prompt as its content (tool results are
 * `user` records too, with `tool_result` blocks: not prompts), or a
 * message that arrived during a turn, which Claude Code records where it
 * read it, as an `attachment` of type `queued_command`.
 */
function promptText(record: unknown): string | null {
  const r = record as {
    type?: unknown;
    message?: { content?: unknown };
    attachment?: { type?: unknown; prompt?: unknown };
  } | null;
  if (!r) return null;
  if (r.type === 'user') return firstText(r.message?.content);
  if (r.type === 'attachment' && r.attachment?.type === 'queued_command')
    return firstText(r.attachment.prompt);
  return null;
}

/** The text of a record that holds a message for the agent's next step: taken during a turn, not read yet. */
function heldText(record: unknown): string | null {
  const r = record as {
    type?: unknown;
    operation?: unknown;
    content?: unknown;
  } | null;
  if (!r || r.type !== 'queue-operation' || r.operation !== 'enqueue')
    return null;
  return firstText(r.content);
}

/**
 * Cuts the file back to just before the last prompt whose text is `text`;
 * returns how many records went, 0 when no such prompt is there (the file
 * is then untouched), and how many prompts are left: none means Claude
 * has no conversation to resume and the caller starts a fresh one.
 * `held` says the message was found waiting instead: sent during a turn
 * that ended before the agent read it. Nothing is cut then, and nothing
 * needs to be, since a resumed Claude does not replay what it held.
 * Written whole to a temp file and renamed.
 */
export function withdrawLastPrompt(
  file: string,
  text: string,
): { removed: number; kept: number; promptsLeft: number; held: boolean } {
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
    // a prompt's own record comes after the one that held it: met first, the message was never read
    if (heldText(rec)?.trim() === text.trim())
      return { removed: 0, kept: lines.length, promptsLeft: -1, held: true };
  }
  if (cut < 0)
    return { removed: 0, kept: lines.length, promptsLeft: -1, held: false };
  const kept = lines.slice(0, cut);
  let promptsLeft = 0;
  for (const l of kept) {
    try {
      if (promptText(JSON.parse(l)) !== null) promptsLeft++;
    } catch {
      /* not a record */
    }
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '');
  fs.renameSync(tmp, file);
  return {
    removed: lines.length - cut,
    kept: kept.length,
    promptsLeft,
    held: false,
  };
}
