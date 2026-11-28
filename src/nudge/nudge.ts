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
  /** What its last message leaves open, each thing in the agent's own words: what the nudge shows it. */
  open: string[];
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

const ago = (ms: number): string => {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 90) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hours`;
  return `${Math.round(h / 24)} days`;
};

/**
 * The nudge, in the manager's own name. It is information more than a
 * question: what the agent itself left open, in its own words, and how
 * the harness works (a turn that ends stops the work). The first
 * version asked the agent to say which of three things its stop was,
 * and it never worked: asked of the judgement that had just decided to
 * stop, at the moment it was most committed to its reason, the answer
 * was one more small item and then "done for now" (the xcom agent,
 * three times of three, and its own account of why: "I can always
 * produce a plausible 'waiting for the person' or 'done'. … It's much
 * harder to call the work done next to my own list saying otherwise").
 * So the list is put in front of it, and the way out asks for a reason
 * per item. Still no order to continue: an agent with nothing left is
 * not pressed into inventing work.
 */
export function nudgeText(
  open: string[],
  /** How long since a person last wrote to it (ms); null when nobody has. */
  quietMs: number | null,
): string {
  const quiet =
    quietMs === null ? '' : ` Nobody has written to you for ${ago(quietMs)}.`;
  const head = `${NUDGE_MARK} you stopped, and nobody is watching.${quiet} A turn that ends stops the work until someone writes; you are asked at that point so that what is open and needs no person gets done while nobody is here.`;
  const tail =
    'What needs them goes in the chat: `am say --question "<what you need>"` reaches their phone, and you carry on with the rest meanwhile. What does not is yours to take up, one thing after the other; say what you finished with `am say` and go on to the next, since ending the turn to report is what stops the work.';
  if (!open.length)
    return `${head}

Your last message does not say what is left. What is, and which of it needs the person, and for what?

${tail}

If nothing is left that is worth doing without them, say so in a line. That is a fine answer, and you are not asked again until they write.`;
  return `${head}

Your last message leaves this open, in your words:
${open.map((o) => `- ${o}`).join('\n')}

Which of it needs the person, and for what?

${tail}

If you are at the end of what is worth doing without them, say for each of these why it is not. That is a fine answer, and you are not asked again until they write.`;
}

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

Whatever the verdict, also list what the message leaves open: each piece of work it names as not done, not checked, still open, remaining, next, or offered ("I can also…"), as a short phrase in the agent's own words, without your judgement of it. Only work somebody could still do: not a fact about how things stand ("the release is still a draft", "setup takes an hour"), not something it reports as finished, not something it explains it deliberately did not do. At most 8, most important first; none if it names none.

Answer with exactly one line of JSON and nothing else:
{"verdict": "<needs_person|done|paused>", "why": "<at most 20 words: what it needs from the person, or what it says is done, or what is left>", "open": ["<a thing it leaves open, at most 25 words>", …]}

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
        open?: unknown;
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
          open: (Array.isArray(o.open) ? o.open : [])
            .filter((x): x is string => typeof x === 'string')
            .map((x) => x.replace(/\s+/g, ' ').trim().slice(0, 300))
            .filter(Boolean)
            .slice(0, 8),
        };
    } catch {
      /* not this line */
    }
  }
  return { verdict: 'paused', why: 'it is not clear why it stopped', open: [] };
}

export interface NudgeRules {
  /** Two nudges are at least this far apart (ms). */
  restMs: number;
  /** No more than this many nudges in a row without a word from a person. */
  maxInRow: number;
}

/**
 * Whether a nudge is due, and no earlier than when; or why not. `last`
 * is the last nudge sent and how many in a row it made, `personAt` when
 * a person last wrote (flow or chat).
 *
 * The first stop after a person's message can always be nudged. After a
 * nudge, the next is at least `restMs` later: the person's rule, "30
 * minutes since last nudge", so that a model that cannot do more is not
 * pressed again and again. It was first built as "only after thirty
 * minutes more of work", which made one nudge the last: an agent that
 * took up one item for ten minutes and stopped again was never asked
 * again, and sat until a person came (once for 37 hours). The pause is
 * a pace now, not an end: what ends it is the agent saying it is done
 * or needs the person, a person writing, or `maxInRow`.
 */
export function due(
  last: { at: number; inRow: number } | null,
  personAt: number | null,
  rules: NudgeRules,
): { ok: true; inRow: number; notBefore: number } | { ok: false; why: string } {
  if (!last || (personAt !== null && personAt > last.at))
    return { ok: true, inRow: 1, notBefore: 0 };
  if (last.inRow >= rules.maxInRow)
    return {
      ok: false,
      why: `it has been asked ${last.inRow} times in a row without a word from a person`,
    };
  return { ok: true, inRow: last.inRow + 1, notBefore: last.at + rules.restMs };
}
