import type { AccountUsage } from '../adapters/adapter.js';

/**
 * What a run cost is the difference between two readings of the vendor's
 * running totals, which only means something if both readings count the
 * same thing. They do not always: `total` is the agent's spend across its
 * sessions and exists only while the manager has those sessions loaded,
 * `spend` is the current session's alone, and a restart can move an agent
 * from one to the other. Subtracting across that boundary is how a run
 * whose turns cost $31 came to read zero (learnings #1).
 *
 * So a reading carries the basis it was taken on, and the session it was
 * taken in; unlike readings are not subtracted at all.
 */
export interface SpendSnapshot {
  basis: 'total' | 'spend';
  /** The agent's session at the time, so two `spend` readings can be known to count the same run of counters. */
  sessionId: string | null;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  /** Absent when the vendor does not price its work. */
  costUsd: number | null;
}

/** Every field null: the honest answer when the two ends cannot be compared. */
export interface RunSpend {
  turns: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export const NO_SPEND: RunSpend = {
  turns: null,
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
};

/**
 * A reading of an agent's usage, on the widest basis the manager has:
 * `total` when it knows the agent's other sessions, `spend` when it knows
 * only this one. Null when the vendor has said nothing at all.
 */
export function snapshotOf(
  usage: AccountUsage | null | undefined,
  sessionId: string | null,
): SpendSnapshot | null {
  const from = usage?.total ?? usage?.spend;
  if (!from) return null;
  return {
    basis: usage?.total ? 'total' : 'spend',
    sessionId,
    turns: from.turns,
    inputTokens: from.inputTokens,
    outputTokens: from.outputTokens,
    costUsd: from.costUsd ?? null,
  };
}

/** Whether the snapshot is one this code wrote (a row from before carries the old shape). */
function usable(s: unknown): s is SpendSnapshot {
  const o = s as SpendSnapshot | null;
  return (
    !!o &&
    typeof o === 'object' &&
    (o.basis === 'total' || o.basis === 'spend') &&
    typeof o.turns === 'number'
  );
}

/**
 * What the run cost, or nothing at all. The rules, in order:
 *
 * - nothing at the close: the vendor said nothing by the time the run
 *   ended, so there is no figure — not a zero;
 * - nothing at the open: the vendor first spoke during the run, so
 *   everything it has said belongs to the run;
 * - different bases, or two `spend` readings from different sessions:
 *   the two ends count different things and are not subtracted;
 * - a counter that went backwards: the vendor or the manager started
 *   over mid-run, so the difference is meaningless.
 *
 * When a reading is refused, every field is null, cost included: half an
 * answer about money is worse than none.
 */
export function runSpend(open: unknown, close: SpendSnapshot | null): RunSpend {
  if (!close) return NO_SPEND;
  const start: SpendSnapshot | null = usable(open) ? open : null;
  if (!start)
    return {
      turns: close.turns,
      inputTokens: close.inputTokens,
      outputTokens: close.outputTokens,
      costUsd: close.costUsd,
    };
  if (start.basis !== close.basis) return NO_SPEND;
  if (
    start.basis === 'spend' &&
    start.sessionId !== null &&
    start.sessionId !== close.sessionId
  )
    return NO_SPEND; // the session's counters began again
  if (
    close.turns < start.turns ||
    close.inputTokens < start.inputTokens ||
    close.outputTokens < start.outputTokens
  )
    return NO_SPEND;
  return {
    turns: close.turns - start.turns,
    inputTokens: close.inputTokens - start.inputTokens,
    outputTokens: close.outputTokens - start.outputTokens,
    costUsd:
      close.costUsd === null || start.costUsd === null
        ? null
        : Math.round((close.costUsd - start.costUsd) * 1e6) / 1e6,
  };
}
