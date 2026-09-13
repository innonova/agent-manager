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
      { name: 'fable', usedPercent: 66, resetsAt: 1789840800000 },
    ]);
    expect(u.status).toBe('warning');
  });
  it('claude: per-model windows keep their family name; a result adds to the spend and names the provider', () => {
    const a = new ClaudeAdapter();
    const w = a.ingest(
      rec({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          unifiedWindows: {
            seven_day_opus: { utilization: 0.12 },
            seven_day_fable: { utilization: 0.5 },
          },
        },
      }),
    ).usage!;
    expect(w.windows.map((x) => x.name)).toEqual(['7d opus', '7d fable']);
    const r = a.ingest(
      rec(
        {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          total_cost_usd: 1.21,
          usage: {
            input_tokens: 258,
            cache_creation_input_tokens: 48837,
            cache_read_input_tokens: 315683,
            output_tokens: 3027,
          },
          modelUsage: { 'claude-fable-5-1': { provider: 'bedrock' } },
        },
        2,
      ),
    ).usage!;
    expect(r.spend).toEqual({
      inputTokens: 364778,
      outputTokens: 3027,
      turns: 1,
      costUsd: 1.21,
    });
    // the cost is the session's running total: a second result replaces it, tokens add up
    const r2 = a.ingest(
      rec(
        {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          total_cost_usd: 1.5,
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        3,
      ),
    ).usage!;
    expect(r2.spend).toEqual({
      inputTokens: 364788,
      outputTokens: 3032,
      turns: 2,
      costUsd: 1.5,
    });
    expect(r2.at).toBe(1000); // the record's time
    expect(r.provider).toBe('bedrock');
    expect(r.windows.map((x) => x.name)).toEqual(['7d opus', '7d fable']); // kept alongside
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
  it('codex: thread/tokenUsage/updated gives the spend and the context, beside the windows', () => {
    const a = new CodexAdapter();
    a.ingest(
      rec({
        method: 'account/rateLimits/updated',
        params: {
          rateLimits: {
            primary: { usedPercent: 6, windowDurationMins: 10080 },
          },
        },
      }),
    );
    const u = a.ingest(
      rec(
        {
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: 't',
            turnId: 'u',
            tokenUsage: {
              total: {
                totalTokens: 30983,
                inputTokens: 30925,
                outputTokens: 58,
              },
              last: { totalTokens: 15523 },
              modelContextWindow: 258400,
            },
          },
        },
        2,
      ),
    ).usage!;
    expect(u.spend).toMatchObject({
      inputTokens: 30925,
      outputTokens: 58,
      turns: 1,
    });
    expect(u.context).toEqual({ used: 15523, size: 258400 });
    expect(u.windows.map((w) => w.name)).toEqual(['7d']);
    expect(u.at).toBe(1000); // the record's time, not now
    // another report of the same turn does not count a second turn; a new turn does
    const again = a.ingest(
      rec(
        {
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: 't',
            turnId: 'u',
            tokenUsage: { total: { inputTokens: 40000, outputTokens: 100 } },
          },
        },
        3,
      ),
    ).usage!;
    expect(again.spend!.turns).toBe(1);
    const next = a.ingest(
      rec(
        {
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: 't',
            turnId: 'v',
            tokenUsage: { total: { inputTokens: 50000, outputTokens: 120 } },
          },
        },
        4,
      ),
    ).usage!;
    expect(next.spend!.turns).toBe(2);
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
    expect(u.spend).toEqual({
      inputTokens: 85000,
      outputTokens: 850,
      costUsd: 0.85,
      turns: 1,
    });
  });
});
