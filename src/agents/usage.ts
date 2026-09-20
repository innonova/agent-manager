import type { AccountUsage } from '../adapters/adapter.js';

/**
 * What the manager puts back on an agent's status from the transcript
 * cache when it starts: what the agent has spent, and nothing else.
 *
 * Spend only accumulates, so a cached figure is never misleading — it is
 * a floor, replaced the moment the session's log is replayed or the
 * vendor reports again. The account's rolling windows are the opposite:
 * a moment in time that expires, so a restored one would claim a limit
 * that may have reset hours ago. They are left out, with the vendor's
 * verdict and the context size; `at` stays the time of the report the
 * figures came from, so a client can see how old they are.
 */
export function spendOnlyUsage(usage: AccountUsage): AccountUsage | null {
  if (!usage.spend) return null;
  return {
    windows: [],
    spend: usage.spend,
    ...(usage.total ? { total: usage.total } : {}),
    at: usage.at,
  };
}
