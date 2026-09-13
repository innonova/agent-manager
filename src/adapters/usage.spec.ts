import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from './claude.adapter.js';
import { CodexAdapter } from './codex.adapter.js';
import { CopilotAdapter } from './copilot.adapter.js';
import { FakeAdapter } from './fake.adapter.js';

const rec = (d: unknown, seq = 1) => ({
  seq,
  t: 1000,
  s: 'out' as const,
  d: JSON.stringify(d),
});

describe('account usage from the vendors', () => {
  it('claude: rate_limit_event gives the 5h and 7d windows and the verdict', () => {
    const u = new ClaudeAdapter().ingest(
      rec({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed_warning',
          unifiedWindows: {
            five_hour: { utilization: 0.33, resetsAt: 1789318800 },
            seven_day: { utilization: 0.41, resetsAt: 1789840800 },
            seven_day_overage_included: {
              utilization: 0.66,
              resetsAt: 1789840800,
            },
          },
        },
      }),
    ).usage!;
    expect(u.windows).toEqual([
      { name: '5h', usedPercent: 33, resetsAt: 1789318800000 },
      { name: '7d', usedPercent: 41, resetsAt: 1789840800000 },
    ]);
    expect(u.status).toBe('warning');
  });
  it('codex: account/rateLimits/updated gives the windows named by their length and the plan', () => {
    const u = new CodexAdapter().ingest(
      rec({
        method: 'account/rateLimits/updated',
        params: {
          rateLimits: {
            primary: {
              usedPercent: 6,
              windowDurationMins: 10080,
              resetsAt: 1789824824,
            },
            secondary: {
              usedPercent: 40,
              windowDurationMins: 300,
              resetsAt: null,
            },
            planType: 'prolite',
            rateLimitReachedType: null,
          },
        },
      }),
    ).usage!;
    expect(u.windows).toEqual([
      { name: '7d', usedPercent: 6, resetsAt: 1789824824000 },
      { name: '5h', usedPercent: 40, resetsAt: null },
    ]);
    expect(u).toMatchObject({ status: 'ok', plan: 'prolite' });
  });
  it('copilot: usage_update is the context window only', () => {
    const a = new CopilotAdapter();
    const u = a.ingest(
      rec({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 's',
          update: { sessionUpdate: 'usage_update', used: 16031, size: 272000 },
        },
      }),
    ).usage!;
    expect(u).toMatchObject({
      windows: [],
      context: { used: 16031, size: 272000 },
    });
  });
  it('fake: a usage line', () => {
    const u = new FakeAdapter().ingest(
      rec({ type: 'usage', fiveHour: 85, sevenDay: 42 }),
    ).usage!;
    expect(u.windows.map((w) => w.usedPercent)).toEqual([85, 42]);
    expect(u.status).toBe('warning');
  });
});
