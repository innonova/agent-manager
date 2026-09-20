import type { AccountUsage } from '../adapters/adapter.js';
import { spendOnlyUsage } from './usage.js';

const full: AccountUsage = {
  windows: [{ name: '5h', usedPercent: 91, resetsAt: 1 }],
  status: 'warning',
  plan: 'max',
  context: { used: 120_000, size: 200_000 },
  spend: { inputTokens: 10, outputTokens: 2, turns: 1, costUsd: 0.5 },
  total: { inputTokens: 30, outputTokens: 6, turns: 3, costUsd: 1.5 },
  provider: 'firstParty',
  at: 1234,
};

describe('usage restored from the cache', () => {
  it('puts back what was spent, and the time it was said', () => {
    expect(spendOnlyUsage(full)).toEqual({
      windows: [],
      spend: full.spend,
      total: full.total,
      at: 1234,
    });
  });

  it('leaves out what expires: the windows, the verdict, the plan, the context', () => {
    const restored = spendOnlyUsage(full)!;
    expect(restored.windows).toEqual([]);
    expect(restored.status).toBeUndefined();
    expect(restored.plan).toBeUndefined();
    expect(restored.context).toBeUndefined();
    expect(restored.provider).toBeUndefined();
  });

  it('has nothing to put back when the session never reported spend', () => {
    const { spend: _spend, total: _total, ...noSpend } = full;
    expect(spendOnlyUsage(noSpend as AccountUsage)).toBeNull();
  });
});
