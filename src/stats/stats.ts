import type { Item } from '../adapters/adapter.js';

/**
 * What an agent's transcript says about how it has been run: how long
 * it worked, on how many tokens, how much of that since a person last
 * wrote to it, and how much with nobody near. Pure: `TurnLog` is fed
 * the transcript's items in order (it can be fed more later), and
 * `statsOf` reads the numbers off it.
 *
 * The unit is the turn: from the message that started it (a person's,
 * another agent's, the manager's own, or the agent resuming by itself
 * when a background job finished) to its end. Runtime is the sum of
 * the turns' lengths by the clock, so waiting on a tool counts and
 * sitting idle between turns does not.
 */

/** Who started a turn. */
export type Starter = 'person' | 'agent' | 'manager' | 'self';

export interface Tokens {
  /** Input the model read fresh. */
  input: number;
  /** Input written to the vendor's cache. */
  cacheWrite: number;
  /** Input read back from the cache: every request of a turn re-reads the context, so this dwarfs the rest. */
  cacheRead: number;
  output: number;
}

export interface Turn {
  start: number;
  /** Null while it runs. */
  end: number | null;
  by: Starter;
  tokens: Tokens;
  /** The cost its end recorded, as recorded: a turn's own, or in older records the session's running total (see `totalCost`). */
  reported: number;
  /** The session it ran in. */
  session: string;
}

/** What `TurnLog` needs of a transcript item. */
export interface LogItem {
  at: number;
  sessionId: string;
  item: Item;
}

const MANAGER = 'manager';
const zero = (): Tokens => ({
  input: 0,
  cacheWrite: 0,
  cacheRead: 0,
  output: 0,
});
const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

/** A turn's tokens from what its end recorded, whichever vendor's names it uses. */
export function tokensOf(usage: unknown): Tokens {
  const u = (usage && typeof usage === 'object' ? usage : {}) as Record<
    string,
    unknown
  >;
  const cached = num(u.cache_read_input_tokens) || num(u.cachedInputTokens);
  return {
    // Codex counts cached input inside its input; Claude counts it beside
    input:
      num(u.input_tokens) ||
      Math.max(0, num(u.inputTokens) - num(u.cachedInputTokens)),
    cacheWrite: num(u.cache_creation_input_tokens),
    cacheRead: cached,
    output: num(u.output_tokens) || num(u.outputTokens),
  };
}

export const who = (by: string | undefined): Starter =>
  by === MANAGER ? 'manager' : by?.startsWith('agent-') ? 'agent' : 'person';

/**
 * The turns of a transcript and the moments a person wrote, built item
 * by item. A `user` item starts a turn, or is a steer into the one
 * under way; Claude's "resumed on its own" starts one nobody sent; a
 * `turn_end` closes it with its tokens and cost; a session ending
 * closes one that never got its end.
 */
export class TurnLog {
  readonly turns: Turn[] = [];
  /** When a person wrote in the flow, and who: a turn or a steer. */
  readonly persons: { at: number; by: string }[] = [];
  private open: Turn | null = null;
  private lastAt = 0;
  feed(s: LogItem): void {
    const it = s.item;
    if (it.kind === 'user') {
      const by = who(it.by);
      if (by === 'person')
        this.persons.push({ at: s.at, by: it.by ?? 'someone' });
      if (!this.open) this.start(s.at, by);
    } else if (it.kind === 'system') {
      if (it.text === 'resumed on its own') {
        if (!this.open) this.start(s.at, 'self');
      } else if (/^session (ended|resumed|started)/.test(it.text))
        this.close(this.lastAt || s.at);
    } else if (it.kind === 'turn_end') {
      // an end with no start seen (history paged in from the middle): its own length says when it began
      if (!this.open) this.start(s.at - num(it.durationMs), 'self');
      const t = this.open!;
      t.tokens = tokensOf(it.usage);
      t.reported = num(it.costUsd);
      t.session = s.sessionId;
      this.close(s.at);
    }
    this.lastAt = s.at;
  }

  private start(at: number, by: Starter): void {
    this.open = {
      start: at,
      end: null,
      by,
      tokens: zero(),
      reported: 0,
      session: '',
    };
    this.turns.push(this.open);
  }

  private close(at: number): void {
    if (!this.open) return;
    this.open.end = Math.max(at, this.open.start);
    this.open = null;
  }

  /** When the last item fed happened: where a turn left open by a session that died is taken to have stopped. */
  get last(): number {
    return this.lastAt;
  }
}

/** A session's records are running totals where they never fall for this many turns in a row; steps do not rise that long by chance. */
const RUNNING_TOTAL_RUN = 8;

/**
 * What the turns cost in all, from what their ends recorded, which is
 * not always a turn's own cost:
 *
 * - The manager's first days recorded the session's running total on
 *   every turn end (learnings #14), and transcripts from then still
 *   hold it. Within a session, a run of eight or more values that
 *   never fall is such a total, and counts once, at its last value.
 * - Claude Code's own counter, in a resumed session, starts from where
 *   the conversation's last session left it, and the adapter takes a
 *   turn's cost as the step from the session's previous total: so the
 *   first turn after a restart carries everything before it (a turn of
 *   no length at $1,723 was seen). A session whose first value is at
 *   least what that counter stood at is taken to carry it, and only
 *   the rest is its own.
 *
 * Summed naively, this project's own agent came to $10,622 where its
 * turns cost about a tenth of that.
 */
export function totalCost(
  turns: { reported: number; session: string }[],
): number {
  const sessions: number[][] = [];
  let at: string | null = null;
  for (const t of turns) {
    if (!t.session) continue; // no end recorded: no cost
    if (t.session !== at) sessions.push([]);
    at = t.session;
    sessions[sessions.length - 1]!.push(t.reported);
  }
  let total = 0;
  /** Where the vendor's own running counter stands after the sessions so far. */
  let counter = 0;
  for (const seq of sessions) {
    const carried = counter > 0 && seq[0]! >= counter * 0.98 ? counter : 0;
    const own = [Math.max(0, seq[0]! - carried), ...seq.slice(1)];
    let sum = 0;
    for (let i = 0; i < own.length;) {
      let j = i;
      while (j + 1 < own.length && own[j + 1]! >= own[j]!) j++;
      if (j - i + 1 >= RUNNING_TOTAL_RUN && own[i]! > 0 && own[j]! >= sum)
        sum = own[j]!;
      else for (let k = i; k <= j; k++) sum += own[k]!;
      i = j + 1;
    }
    total += sum;
    counter = carried + sum;
  }
  return total;
}

/** Work more than this long after a person last wrote counts as unattended: they have most likely gone to do something else. */
export const UNATTENDED_AFTER_MS = 30 * 60_000;

export interface Sum {
  turns: number;
  runtimeMs: number;
}

export interface Stats {
  /** The first thing in the transcript, unix ms; null for an agent that never ran. */
  since: number | null;
  turns: number;
  /** The turns' lengths added up. */
  runtimeMs: number;
  tokens: Tokens;
  costUsd: number;
  /** Whether a turn is under way now; its time so far is counted. */
  working: boolean;
  /** Turns and their time, by who started them. */
  startedBy: Record<Starter, Sum>;
  /** Since a person's last direct message: one in the flow, a turn or a steer. What is said in the chat is beside the work. */
  sinceLastMessage: {
    at: number;
    by: string;
    /** The agent's working time since then. */
    runtimeMs: number;
    /** Turns that began since then. */
    turns: number;
    /** Output tokens of the turns that ended since then. */
    outputTokens: number;
  } | null;
  /** The runs between one direct message from a person and the next: how long the agent worked on each. */
  runs: {
    count: number;
    medianMs: number;
    longestMs: number;
    /** The longest ones, newest first among equals: when the message was written and how long the agent then worked. */
    longest: { at: number; by: string; runtimeMs: number }[];
  };
  /** Work done more than `afterMs` after a person last wrote anything, in the flow or the chat. */
  unattended: {
    afterMs: number;
    runtimeMs: number;
    /** Its share of all runtime, 0 to 1. */
    share: number;
    /** Runs that went on past that point. */
    runs: number;
    longestMs: number;
    medianMs: number;
  };
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};

/** The agent's working time since a moment, as of `now`: the turns' lengths from then on, one under way counted up to now. */
export function workSince(
  log: TurnLog,
  at: number,
  now: number,
  working: boolean,
): number {
  let ms = 0;
  for (const t of log.turns) {
    const end = t.end ?? (working ? now : Math.max(log.last, t.start));
    if (end <= at) continue;
    ms += end - Math.max(t.start, at);
  }
  return ms;
}

/**
 * The numbers, as of `now`. `messages` are the moments a person wrote
 * in the chat beside the work, which counts for whether somebody was
 * there and not for where a run ends;
 * `working` says whether the turn left open is really under way, or
 * was cut off and stopped at the last thing recorded.
 */
export function statsOf(
  log: TurnLog,
  now: number,
  working: boolean,
  chat: { at: number; by: string }[] = [],
): Stats {
  const turns = log.turns.map((t) => ({
    ...t,
    end: t.end ?? (working ? now : Math.max(log.last, t.start)),
  }));
  // Direct messages, in the flow, are what a run lies between. What a
  // person says in the chat is beside the work and ends no run (an answer
  // to the agent's question in the middle of a 24-hour turn made it read
  // as 18 hours), but it does show that somebody was there.
  const direct = [...log.persons].sort((a, b) => a.at - b.at);
  const seen = [...direct, ...chat].sort((a, b) => a.at - b.at);
  const overlap = (from: number, to: number): number => {
    let ms = 0;
    for (const t of turns) {
      if (t.end <= from || t.start >= to) continue;
      ms += Math.min(t.end, to) - Math.max(t.start, from);
    }
    return ms;
  };
  const startedBy: Record<Starter, Sum> = {
    person: { turns: 0, runtimeMs: 0 },
    agent: { turns: 0, runtimeMs: 0 },
    manager: { turns: 0, runtimeMs: 0 },
    self: { turns: 0, runtimeMs: 0 },
  };
  const tokens = zero();
  let runtimeMs = 0;
  for (const t of turns) {
    const ms = t.end - t.start;
    runtimeMs += ms;
    startedBy[t.by].turns++;
    startedBy[t.by].runtimeMs += ms;
    tokens.input += t.tokens.input;
    tokens.cacheWrite += t.tokens.cacheWrite;
    tokens.cacheRead += t.tokens.cacheRead;
    tokens.output += t.tokens.output;
  }
  // one run per direct message: the work between it and the next one
  const runs: { at: number; by: string; runtimeMs: number; late: number }[] =
    [];
  for (const [i, m] of direct.entries()) {
    const until = direct[i + 1]?.at ?? Infinity;
    const ms = overlap(m.at, until);
    if (ms <= 0) continue;
    // of it, what was done more than the half hour after anyone last wrote, the chat included
    let late = 0;
    const within = seen.filter((x) => x.at >= m.at && x.at < until);
    for (const [k, x] of within.entries()) {
      const next = within[k + 1]?.at ?? until;
      late += overlap(Math.min(next, x.at + UNATTENDED_AFTER_MS), next);
    }
    runs.push({ at: m.at, by: m.by, runtimeMs: ms, late });
  }
  // before anyone wrote, nobody was near either
  const before = seen.length ? overlap(-Infinity, seen[0]!.at) : runtimeMs;
  const late = runs.filter((r) => r.late > 0).map((r) => r.late);
  const unattendedMs = late.reduce((a, b) => a + b, 0) + before;
  const last = direct[direct.length - 1];
  return {
    since: log.turns[0]?.start ?? null,
    turns: turns.length,
    runtimeMs,
    tokens,
    costUsd: Math.round(totalCost(log.turns) * 100) / 100,
    working: working && log.turns[log.turns.length - 1]?.end === null,
    startedBy,
    sinceLastMessage: last
      ? {
          at: last.at,
          by: last.by,
          runtimeMs: overlap(last.at, Infinity),
          turns: turns.filter((t) => t.start >= last.at).length,
          outputTokens: turns
            .filter((t) => t.end > last.at)
            .reduce((n, t) => n + t.tokens.output, 0),
        }
      : null,
    runs: {
      count: runs.length,
      medianMs: median(runs.map((r) => r.runtimeMs)),
      longestMs: Math.max(0, ...runs.map((r) => r.runtimeMs)),
      longest: [...runs]
        .sort((a, b) => b.runtimeMs - a.runtimeMs || b.at - a.at)
        .slice(0, 5)
        .map(({ at, by, runtimeMs: ms }) => ({ at, by, runtimeMs: ms })),
    },
    unattended: {
      afterMs: UNATTENDED_AFTER_MS,
      runtimeMs: unattendedMs,
      share: runtimeMs ? unattendedMs / runtimeMs : 0,
      runs: late.length,
      longestMs: Math.max(0, ...late),
      medianMs: median(late),
    },
  };
}
