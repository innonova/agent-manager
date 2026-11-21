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
  /** As the vendor priced it, when it does. */
  costUsd: number;
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
  /** What the turns before cost in all, for telling a carried-over total from a turn's own cost. */
  private costSoFar = 0;
  private costSession: string | null = null;

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
      t.costUsd = this.cost(num(it.costUsd), s.sessionId);
      this.close(s.at);
    }
    this.lastAt = s.at;
  }

  private start(at: number, by: Starter): void {
    this.open = { start: at, end: null, by, tokens: zero(), costUsd: 0 };
    this.turns.push(this.open);
  }

  private close(at: number): void {
    if (!this.open) return;
    this.open.end = Math.max(at, this.open.start);
    this.open = null;
  }

  /**
   * A turn's cost. Claude Code's running total starts, in a resumed
   * session, from what the conversation cost before, and the adapter
   * takes each turn's cost as the step from the session's previous
   * total: so the first turn after a restart carries everything before
   * it (a turn of no length at $1,723 was seen). Such a turn is given
   * what it adds to the sum so far.
   */
  private cost(reported: number, session: string): number {
    const first = session !== this.costSession;
    this.costSession = session;
    const own =
      first && this.costSoFar > 1 && reported > this.costSoFar * 0.5
        ? Math.max(0, reported - this.costSoFar)
        : reported;
    this.costSoFar += own;
    return own;
  }

  /** When the last item fed happened: where a turn left open by a session that died is taken to have stopped. */
  get last(): number {
    return this.lastAt;
  }
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
  /** Since a person last wrote, in the flow or the chat. */
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
  /** The runs between one message from a person and the next: how long the agent worked on each. */
  runs: {
    count: number;
    medianMs: number;
    longestMs: number;
    /** The longest ones, newest first among equals: when the message was written and how long the agent then worked. */
    longest: { at: number; by: string; runtimeMs: number }[];
  };
  /** Work done more than `afterMs` after a person last wrote. */
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

/**
 * The numbers, as of `now`. `messages` are the moments a person wrote
 * (the log's own, plus what they said in the chat beside the work);
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
  const messages = [...log.persons, ...chat].sort((a, b) => a.at - b.at);
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
  let costUsd = 0;
  for (const t of turns) {
    const ms = t.end - t.start;
    runtimeMs += ms;
    startedBy[t.by].turns++;
    startedBy[t.by].runtimeMs += ms;
    tokens.input += t.tokens.input;
    tokens.cacheWrite += t.tokens.cacheWrite;
    tokens.cacheRead += t.tokens.cacheRead;
    tokens.output += t.tokens.output;
    costUsd += t.costUsd;
  }
  // one run per message: the work between it and the next one
  const runs: { at: number; by: string; runtimeMs: number; late: number }[] =
    [];
  for (const [i, m] of messages.entries()) {
    const until = messages[i + 1]?.at ?? Infinity;
    const ms = overlap(m.at, until);
    if (ms <= 0) continue;
    runs.push({
      at: m.at,
      by: m.by,
      runtimeMs: ms,
      late: overlap(Math.min(until, m.at + UNATTENDED_AFTER_MS), until),
    });
  }
  // before anyone wrote, nobody was near either
  const before = messages.length
    ? overlap(-Infinity, messages[0]!.at)
    : runtimeMs;
  const late = runs.filter((r) => r.late > 0).map((r) => r.late);
  const unattendedMs = late.reduce((a, b) => a + b, 0) + before;
  const last = messages[messages.length - 1];
  return {
    since: log.turns[0]?.start ?? null,
    turns: turns.length,
    runtimeMs,
    tokens,
    costUsd: Math.round(costUsd * 100) / 100,
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
