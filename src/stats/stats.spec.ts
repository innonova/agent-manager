import type { Item } from '../adapters/adapter.js';
import {
  statsOf,
  tokensOf,
  totalCost,
  TurnLog,
  UNATTENDED_AFTER_MS,
} from './stats.js';

const MIN = 60_000;
const H = 60 * MIN;
/** Feeds items given as [minute, item], all in one session unless said. */
function log(list: [number, Item, string?][]): TurnLog {
  const l = new TurnLog();
  for (const [min, item, session] of list)
    l.feed({ at: min * MIN, sessionId: session ?? 's1', item });
  return l;
}
const user = (by?: string): Item => ({ kind: 'user', text: 'x', by });
const end = (
  over: Partial<Extract<Item, { kind: 'turn_end' }>> = {},
): Item => ({
  kind: 'turn_end',
  ...over,
});
const sys = (text: string): Item => ({ kind: 'system', text });
const text: Item = { kind: 'text', text: 'working', streaming: false };

describe('TurnLog', () => {
  it('makes turns of what started them: a person, another agent, the manager, the agent itself; a steer starts none', () => {
    const l = log([
      [0, user('aek')],
      [5, user('djm')], // a steer into the turn under way
      [
        10,
        end({
          usage: {
            input_tokens: 1,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3,
            output_tokens: 4,
          },
          costUsd: 0.5,
        }),
      ],
      [20, sys('resumed on its own')],
      [21, end()],
      [30, user('manager')],
      [32, end()],
      [40, user('agent-claude')],
      [45, end()],
    ]);
    expect(l.turns.map((t) => [t.by, t.start / MIN, t.end! / MIN])).toEqual([
      ['person', 0, 10],
      ['self', 20, 21],
      ['manager', 30, 32],
      ['agent', 40, 45],
    ]);
    expect(l.turns[0]).toMatchObject({
      tokens: { input: 1, cacheWrite: 2, cacheRead: 3, output: 4 },
      reported: 0.5,
      session: 's1',
    });
    expect(l.persons).toEqual([
      { at: 0, by: 'aek' },
      { at: 5 * MIN, by: 'djm' },
    ]);
  });

  it('closes a turn its session never ended at the last thing recorded', () => {
    const l = log([
      [0, user('aek')],
      [7, text],
      [50, sys('session ended (exit code 1)')],
      [50, sys('session resumed (s2)')],
      [60, user('aek'), 's2'],
      [61, end({}), 's2'],
    ]);
    expect(l.turns.map((t) => [t.start / MIN, t.end! / MIN])).toEqual([
      [0, 7],
      [60, 61],
    ]);
  });

  it("sums cost from records that are not all a turn's own: old running totals, and a counter carried across a restart", () => {
    const t = (session: string, ...values: number[]) =>
      values.map((reported) => ({ reported, session }));
    // each turn's own cost: just the sum
    expect(totalCost(t('a', 3, 1, 4, 1, 5))).toBe(14);
    // the first days recorded the session's running total on every turn: it counts once
    expect(
      totalCost(t('a', 1.2, 3, 3.4, 3.9, 4.4, 5.5, 6.1, 8.5, 11, 143)),
    ).toBe(143);
    // a session that switched from totals to steps in the middle
    expect(totalCost(t('a', 1, 2, 3, 4, 5, 6, 7, 37, 0.3, 4.5, 4))).toBeCloseTo(
      45.8,
    );
    // Claude's counter carried over: the second session starts at 14.04 plus its own 8.46,
    // the third at what the second left it at, plus nothing
    expect(
      totalCost([
        ...t('a', 8.35),
        ...t('b', 9.6, 4.44),
        ...t('c', 22.5, 0.5, 7.5),
        ...t('d', 30.5, 2),
      ]),
    ).toBeCloseTo(8.35 + 1.25 + 4.44 + 8.46 + 0.5 + 7.5 + 0 + 2);
    // a counter that started over: a first turn that is just a turn
    expect(totalCost([...t('a', 100, 50), ...t('b', 4, 1)])).toBe(155);
    // eight free turns in a row are not a running total of nothing
    expect(totalCost(t('a', 5, 0, 0, 0, 0, 0, 0, 0, 0, 2))).toBe(7);
    // a turn with no end recorded has no session and no cost
    expect(totalCost([{ reported: 0, session: '' }, ...t('a', 2)])).toBe(2);
  });

  it("reads a turn's tokens under either vendor's names", () => {
    expect(
      tokensOf({ inputTokens: 100, cachedInputTokens: 80, outputTokens: 7 }),
    ).toEqual({
      input: 20,
      cacheWrite: 0,
      cacheRead: 80,
      output: 7,
    });
    expect(tokensOf(undefined)).toEqual({
      input: 0,
      cacheWrite: 0,
      cacheRead: 0,
      output: 0,
    });
  });
});

describe('statsOf', () => {
  it('does not end a run at what a person says in the chat, but takes it as somebody being there', () => {
    // one turn of 24 hours on one message, with a question answered in the chat after 18
    const l = log([
      [0, user('aek')],
      [24 * 60, end()],
      [24 * 60 + 10, user('aek')],
      [24 * 60 + 11, end()],
    ]);
    const s = statsOf(l, 30 * H, false, [{ at: 18 * H, by: 'aek' }]);
    expect(s.runs.longest[0]).toEqual({ at: 0, by: 'aek', runtimeMs: 24 * H });
    expect(s.runs.count).toBe(2);
    // unattended: all of it but the half hour after the message and the half hour after the answer
    expect(s.unattended).toMatchObject({
      runtimeMs: 23 * H,
      runs: 1,
      longestMs: 23 * H,
    });
  });

  it('adds up runtime, tokens and cost, and says who started what', () => {
    const l = log([
      [0, user('aek')],
      [10, end({ usage: { output_tokens: 10 }, costUsd: 1 })],
      [20, sys('resumed on its own')],
      [25, end({ usage: { output_tokens: 5 }, costUsd: 0.5 })],
    ]);
    const s = statsOf(l, 100 * MIN, false);
    expect(s).toMatchObject({
      since: 0,
      turns: 2,
      runtimeMs: 15 * MIN,
      costUsd: 1.5,
      working: false,
      tokens: { output: 15 },
      startedBy: {
        person: { turns: 1, runtimeMs: 10 * MIN },
        self: { turns: 1, runtimeMs: 5 * MIN },
      },
    });
  });

  it('counts a turn under way up to now, and one that was cut off up to the last thing recorded', () => {
    const l = log([
      [0, user('aek')],
      [4, text],
    ]);
    expect(statsOf(l, 10 * MIN, true)).toMatchObject({
      runtimeMs: 10 * MIN,
      working: true,
    });
    expect(statsOf(l, 10 * MIN, false)).toMatchObject({
      runtimeMs: 4 * MIN,
      working: false,
    });
  });

  it('says how long the agent has worked since a person last wrote, in the flow or the chat', () => {
    const l = log([
      [0, user('aek')],
      [10, end({ usage: { output_tokens: 1 } })],
      [20, user('aek')],
      [30, end({ usage: { output_tokens: 2 } })],
      [40, user('manager')], // the manager's poke is not a person writing
      [45, end({ usage: { output_tokens: 4 } })],
    ]);
    expect(statsOf(l, H, false).sinceLastMessage).toEqual({
      at: 20 * MIN,
      by: 'aek',
      runtimeMs: 15 * MIN,
      turns: 2,
      outputTokens: 6,
    });
    // something said beside the work at minute 42 is not a direct message
    expect(
      statsOf(l, H, false, [{ at: 42 * MIN, by: 'djm' }]).sinceLastMessage,
    ).toMatchObject({ at: 20 * MIN, by: 'aek', runtimeMs: 15 * MIN });
    expect(statsOf(new TurnLog(), H, false).sinceLastMessage).toBeNull();
  });

  it('takes the work between two messages as one run, and what went on past half an hour as unattended', () => {
    const l = log([
      [0, user('aek')],
      [20, end()], // a short run: 20 minutes, all of it attended
      [100, user('aek')],
      [220, end()], // two hours on one message: 90 minutes of it past the half hour
      [230, sys('resumed on its own')],
      [240, end()], // and ten more by itself, nobody having written since
      [300, user('aek')],
      [301, end()],
    ]);
    const s = statsOf(l, 400 * MIN, false);
    expect(s.runs).toEqual({
      count: 3,
      medianMs: 20 * MIN,
      longestMs: 130 * MIN,
      longest: [
        { at: 100 * MIN, by: 'aek', runtimeMs: 130 * MIN },
        { at: 0, by: 'aek', runtimeMs: 20 * MIN },
        { at: 300 * MIN, by: 'aek', runtimeMs: MIN },
      ],
    });
    expect(s.unattended).toEqual({
      afterMs: UNATTENDED_AFTER_MS,
      runtimeMs: 100 * MIN,
      share: 100 / 151,
      runs: 1,
      longestMs: 100 * MIN,
      medianMs: 100 * MIN,
    });
  });
});
