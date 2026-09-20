import type { AccountUsage } from '../adapters/adapter.js';
import {
  NO_SPEND,
  runSpend,
  snapshotOf,
  type SpendSnapshot,
} from './run-spend.js';

const spend = (
  turns: number,
  inTok: number,
  outTok: number,
  cost?: number,
) => ({
  turns,
  inputTokens: inTok,
  outputTokens: outTok,
  ...(cost === undefined ? {} : { costUsd: cost }),
});

const usage = (u: Partial<AccountUsage>): AccountUsage => ({
  windows: [],
  at: 1,
  ...u,
});

const snap = (
  basis: 'total' | 'spend',
  turns: number,
  inTok: number,
  outTok: number,
  cost: number | null = null,
  sessionId: string | null = 's1',
): SpendSnapshot => ({
  basis,
  sessionId,
  turns,
  inputTokens: inTok,
  outputTokens: outTok,
  costUsd: cost,
});

describe('a run’s spend', () => {
  it('reads the widest basis the manager has, and says which it was', () => {
    expect(
      snapshotOf(
        usage({ spend: spend(2, 10, 1), total: spend(5, 30, 3, 0.5) }),
        's1',
      ),
    ).toEqual({
      basis: 'total',
      sessionId: 's1',
      turns: 5,
      inputTokens: 30,
      outputTokens: 3,
      costUsd: 0.5,
    });
    expect(snapshotOf(usage({ spend: spend(2, 10, 1) }), 's1')).toMatchObject({
      basis: 'spend',
      turns: 2,
      costUsd: null,
    });
    expect(snapshotOf(usage({}), 's1')).toBeNull();
    expect(snapshotOf(null, 's1')).toBeNull();
  });

  it('subtracts two readings of the same basis', () => {
    expect(
      runSpend(snap('total', 5, 30, 3, 0.5), snap('total', 9, 80, 11, 1.25)),
    ).toEqual({
      turns: 4,
      inputTokens: 50,
      outputTokens: 8,
      costUsd: 0.75,
    });
  });

  it('refuses to subtract a session’s spend from the agent’s total', () => {
    // the reinstall case: `total` at the open, only `spend` at the close
    expect(
      runSpend(snap('total', 9, 80, 11, 1.25), snap('spend', 3, 20, 2, 0.4)),
    ).toEqual(NO_SPEND);
    expect(
      runSpend(snap('spend', 3, 20, 2, 0.4), snap('total', 9, 80, 11, 1.25)),
    ).toEqual(NO_SPEND);
  });

  it('refuses two session readings from different sessions', () => {
    expect(
      runSpend(
        snap('spend', 3, 20, 2, 0.4, 's1'),
        snap('spend', 8, 90, 9, 0.9, 's2'),
      ),
    ).toEqual(NO_SPEND);
    // the same session is fine
    expect(
      runSpend(
        snap('spend', 3, 20, 2, 0.4, 's1'),
        snap('spend', 8, 90, 9, 0.9, 's1'),
      ),
    ).toMatchObject({ turns: 5, inputTokens: 70 });
  });

  it('refuses a counter that went backwards', () => {
    expect(
      runSpend(snap('total', 9, 80, 11, 1.25), snap('total', 9, 79, 11, 1.25)),
    ).toEqual(NO_SPEND);
  });

  it('counts everything when the vendor first spoke during the run', () => {
    expect(runSpend(null, snap('total', 4, 40, 5, 0.6))).toEqual({
      turns: 4,
      inputTokens: 40,
      outputTokens: 5,
      costUsd: 0.6,
    });
  });

  it('has no figure at all when the vendor said nothing by the close', () => {
    expect(runSpend(snap('total', 4, 40, 5, 0.6), null)).toEqual(NO_SPEND);
    expect(runSpend(null, null)).toEqual(NO_SPEND);
  });

  it('treats a row written before this existed as no starting point', () => {
    // the old shape: the numbers without a basis
    const old = { turns: 4, inputTokens: 40, outputTokens: 5, costUsd: 0.6 };
    expect(runSpend(old, snap('total', 9, 80, 11, 1.25))).toEqual({
      turns: 9,
      inputTokens: 80,
      outputTokens: 11,
      costUsd: 1.25,
    });
  });

  it('gives no partial answer about money', () => {
    // a vendor that priced one end and not the other says nothing usable
    expect(
      runSpend(snap('total', 4, 40, 5, null), snap('total', 9, 80, 11, 1.25))
        .costUsd,
    ).toBeNull();
    // but the tokens it did report are still a difference
    expect(
      runSpend(snap('total', 4, 40, 5, null), snap('total', 9, 80, 11, 1.25)),
    ).toMatchObject({ turns: 5, inputTokens: 40, outputTokens: 6 });
  });
});
