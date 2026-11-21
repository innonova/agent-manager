import type { Item } from '../adapters/adapter.js';
import { statsOf, tokensOf, TurnLog, UNATTENDED_AFTER_MS } from './stats.js';

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
      costUsd: 0.5,
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

  it("gives the first turn after a restart its own cost, not the conversation's carried-over total", () => {
    const l = log([
      [0, user('aek')],
      [10, end({ costUsd: 100 })],
      [20, user('aek')],
      [30, end({ costUsd: 50 })],
      // restarted: Claude's total starts from the 150 before, and the turn itself cost 2
      [40, sys('session resumed (s2)')],
      [40, sys('resumed on its own'), 's2'],
      [40, end({ costUsd: 152 }), 's2'],
      [50, user('aek'), 's2'],
      [55, end({ costUsd: 3 }), 's2'],
      // a vendor that starts from zero: a first turn that is just a turn
      [60, user('aek'), 's3'],
      [65, end({ costUsd: 4 }), 's3'],
    ]);
    expect(l.turns.map((t) => t.costUsd)).toEqual([100, 50, 2, 3, 4]);
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
    // said beside the work at minute 42: three minutes of work since
    expect(
      statsOf(l, H, false, [{ at: 42 * MIN, by: 'djm' }]).sinceLastMessage,
    ).toMatchObject({
      at: 42 * MIN,
      by: 'djm',
      runtimeMs: 3 * MIN,
      turns: 0,
      outputTokens: 4,
    });
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
