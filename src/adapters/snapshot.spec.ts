import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from './claude.adapter.js';
import { CodexAdapter } from './codex.adapter.js';
import { CopilotAdapter } from './copilot.adapter.js';
import { FakeAdapter } from './fake.adapter.js';
import { loadFixture, replay } from './replay-harness.js';
import type { AgentAdapter } from './adapter.js';
import type { LogRecord } from '../daemon/daemon-client.js';

/**
 * A restart from the transcript cache restores an adapter from its
 * snapshot at a turn end and feeds it the rest of the log. That must give
 * the same items, states and sends as one adapter reading the whole log.
 */
const vendors: [string, () => AgentAdapter, string][] = [
  ['claude', () => new ClaudeAdapter(), 'tool-and-text.ndjson'],
  ['codex', () => new CodexAdapter(), 'tool-and-text.ndjson'],
  ['copilot', () => new CopilotAdapter(), 'tool-and-text.ndjson'],
  ['claude', () => new ClaudeAdapter(), 'background-task.ndjson'],
  ['codex', () => new CodexAdapter(), 'background-command.ndjson'],
  ['copilot', () => new CopilotAdapter(), 'background-command.ndjson'],
];

/** Seq of the record that produced the first turn_end. */
function firstTurnEnd(make: () => AgentAdapter, records: LogRecord[]): number {
  const a = make();
  for (const r of records)
    if ((a.ingest(r).ops ?? []).some((op) => op.item.kind === 'turn_end'))
      return r.seq;
  throw new Error('no turn end in fixture');
}

describe.each(vendors)('%s snapshot/restore (%s)', (_vendor, make, fixture) => {
  const records = loadFixture(_vendor, fixture);
  it('continues after a turn end exactly like an uninterrupted replay', () => {
    const cut = firstTurnEnd(make, records);
    const head = records.filter((r) => r.seq <= cut);
    const tail = records.filter((r) => r.seq > cut);
    const whole = replay(make(), records);
    const first = make();
    const headResult = replay(first, head);
    const snapshot = JSON.parse(JSON.stringify(first.snapshot!()));
    const second = make();
    second.restore!(snapshot);
    const tailResult = replay(second, tail);
    expect(tailResult.items).toEqual(
      whole.items.slice(headResult.items.length),
    );
    expect([...headResult.states, ...tailResult.states]).toEqual(whole.states);
    expect([...headResult.sent, ...tailResult.sent]).toEqual(whole.sent);
    expect([...headResult.backgrounds, ...tailResult.backgrounds]).toEqual(
      whole.backgrounds,
    );
    expect(second.turnInProgress?.()).toBe(
      make().turnInProgress?.() === undefined ? undefined : false,
    );
    expect(second.pendingPermissions?.() ?? []).toEqual([]);
    if (second.afterReplay)
      expect(
        second.afterReplay({ cwd: '/w', resume: null, permissions: 'bypass' }),
      ).toEqual([]);
  });
});

describe('fake adapter snapshot', () => {
  it('round-trips', () => {
    const a = new FakeAdapter();
    const b = new FakeAdapter();
    b.restore(JSON.parse(JSON.stringify(a.snapshot())));
    expect(b.snapshot()).toEqual(a.snapshot());
  });
});
