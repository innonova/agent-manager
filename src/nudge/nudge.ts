import type { Item } from '../adapters/adapter.js';

/**
 * Asking an agent that stopped whether it can go on (see
 * `features/nudge-when-an-agent-stops` and the design's "Nudge"). Pure:
 * what the manager reads off the end of a transcript, what the model
 * that reads the last message is told and how its answer is read, when
 * a nudge is due, and the words of the nudge.
 */

export type Verdict = 'needs_person' | 'done' | 'paused';

export interface Reading {
  verdict: Verdict;
  /** One line: what it needs, or what it says is done, or what is left. */
  why: string;
}

/** What the end of the transcript says about the turn that just ended. */
export interface LastTurn {
  /** The agent's last text of the turn: what it left the person with. Null when it wrote none. */
  text: string | null;
  /** A person stopped the turn, or took its message back: they are there, and it is theirs to say what next. */
  stoppedByPerson: boolean;
  /** The last thing a person wrote before it, for the reader's context. */
  asked: string | null;
}

/** The words every nudge begins with, so that one can be told from any other message of the manager's. */
export const NUDGE_MARK = 'The manager, not a person:';

/**
 * The nudge. A question with three answers, in the manager's own name:
 * the agent is the one who knows whether there is work left, and an
 * order to continue would press one that has none into inventing some.
 */
export const NUDGE_TEXT = `${NUDGE_MARK} you stopped, and nobody is watching right now. Which of these is it?

- There is meaningful work left that you can do without the person: then carry on with it. You need not answer this message first.
- You need the person for something (a decision, an answer, a look, access): say what in one or two lines, and they will be paged. \`am say --question "<what you need>"\` puts it in the chat and on their phone.
- The work is done, or nothing that is left is worth doing without them: say so in a line. That is a fine answer, and you will not be asked again until the person writes.

This is a question, not an instruction to continue.`;

/**
 * The end of a transcript, walked back from the last item to the start
 * of the turn that just ended.
 */
export function lastTurn(items: { item: Item }[]): LastTurn {
  let text: string | null = null;
  let stoppedByPerson = false;
  let asked: string | null = null;
  let i = items.length - 1;
  // the turn itself: back to what started it
  for (; i >= 0; i--) {
    const it = items[i]!.item;
    if (it.kind === 'text' && !it.streaming && text === null && it.text.trim())
      text = it.text.trim();
    else if (it.kind === 'system') {
      if (/^(interrupt requested|withdrawn)/.test(it.text))
        stoppedByPerson = true;
      if (it.text === 'resumed on its own') break;
    } else if (it.kind === 'user') break;
  }
  // and the last thing a person wrote, in this turn or before it
  for (; i >= 0 && asked === null; i--) {
    const it = items[i]!.item;
    if (
      it.kind === 'user' &&
      it.by !== 'manager' &&
      !it.by?.startsWith('agent-')
    )
      asked = it.text.trim();
  }
  return { text, stoppedByPerson, asked };
}

const clip = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n)}\n[…cut…]` : s;
const clipEnd = (s: string, n: number): string =>
  s.length > n ? `[…cut…]\n${s.slice(-n)}` : s;

/** What the model that reads a last message is given: the instructions, then the message, with what the person last wrote for context. */
export function readerInput(turn: LastTurn): string {
  return `A coding agent works on a long job for a person who is not watching. It has just stopped. Read its last message and say which of three things is the case. You are not asked whether its work is good, only why it stopped.

needs_person: it cannot usefully go on without the person. It asks them a question, waits for a decision or an approval, wants them to look at or try something before it continues, lacks access or a credential, or says it is blocked. An offer ("say the word and I'll…", "if you want I can…") that it could simply act on is not this, unless it says it must not act without them.
done: it says the work it was given is finished and names nothing further it would do; or it says that what is left is not worth doing or not its to do.
paused: anything else. It reports a milestone, a result or progress, and there is work left that it names or implies and could take up by itself ("next I would…", "remaining:", a list of open items, a plan with steps not yet done), or it is simply not clear why it stopped.

When in doubt between needs_person and paused, say paused: the agent will be asked, and can say that it needs the person. When in doubt between done and paused, say paused.

Answer with exactly one line of JSON and nothing else:
{"verdict": "<needs_person|done|paused>", "why": "<at most 20 words: what it needs from the person, or what it says is done, or what is left>"}

${turn.asked ? `What the person last wrote to it:\n<person>\n${clip(turn.asked, 3000)}\n</person>\n\n` : ''}The agent's last message:
<agent>
${clipEnd(turn.text ?? '(it wrote nothing)', 12_000)}
</agent>
`;
}

/** The reader's answer, read leniently; one that cannot be read is "paused": not clear why it stopped, so the agent is asked. */
export function parseReading(out: string): Reading {
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    const from = line.indexOf('{');
    if (from < 0) continue;
    try {
      const o = JSON.parse(line.slice(from, line.lastIndexOf('}') + 1)) as {
        verdict?: unknown;
        why?: unknown;
      };
      if (
        o.verdict === 'needs_person' ||
        o.verdict === 'done' ||
        o.verdict === 'paused'
      )
        return {
          verdict: o.verdict,
          why: String(o.why ?? '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 240),
        };
    } catch {
      /* not this line */
    }
  }
  return { verdict: 'paused', why: 'it is not clear why it stopped' };
}

export interface NudgeRules {
  /** An agent is nudged again only after this much work since the last nudge (ms). */
  workMs: number;
  /** No more than this many nudges in a row without a word from a person. */
  maxInRow: number;
}

/**
 * Whether a nudge is due, or why not. `last` is the last nudge sent
 * and how many in a row it made, `personAt` when a person last wrote
 * (flow or chat), `workedSince` the agent's work since that nudge.
 *
 * The first stop after a person's message can always be nudged,
 * however short the work. After a nudge, only once the agent has
 * worked `workMs` more: one that answered in a minute cannot do more,
 * and is left alone until a person writes.
 */
export function due(
  last: { at: number; inRow: number } | null,
  personAt: number | null,
  workedSince: number,
  rules: NudgeRules,
): { ok: true; inRow: number } | { ok: false; why: string } {
  if (!last || (personAt !== null && personAt > last.at))
    return { ok: true, inRow: 1 };
  if (workedSince < rules.workMs)
    return {
      ok: false,
      why: `it has worked ${Math.round(workedSince / 60_000)} min since it was last asked`,
    };
  if (last.inRow >= rules.maxInRow)
    return {
      ok: false,
      why: `it has been asked ${last.inRow} times in a row without a word from a person`,
    };
  return { ok: true, inRow: last.inRow + 1 };
}
