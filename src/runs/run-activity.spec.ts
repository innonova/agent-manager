import type { Item } from '../adapters/adapter.js';
import { MANAGER_AUTHOR, type StoredItem } from '../agents/agents.service.js';
import { lastOwnActivity } from './run-activity.js';

let index = 0;
const at = (t: number, item: Item): StoredItem => ({
  index: index++,
  sessionId: 's1',
  seqFrom: 0,
  seqTo: 0,
  at: t,
  item,
});

const text = (t: number, s = 'hi') =>
  at(t, { kind: 'text', text: s, streaming: false });
const end = (t: number) => at(t, { kind: 'turn_end' });
const user = (t: number, by?: string) => at(t, { kind: 'user', text: 'x', by });
const poke = (t: number) => user(t, MANAGER_AUTHOR);

describe('a run’s own activity', () => {
  it('is the agent working, not a message it was sent', () => {
    expect(lastOwnActivity([user(10), text(20), end(30)])).toBe(30);
    expect(lastOwnActivity([user(10)])).toBeNull();
    expect(lastOwnActivity([])).toBeNull();
  });

  it('ignores the turn the manager’s poke opens, however the agent answers it', () => {
    // exactly what a stalled agent looks like: nothing but pokes and the
    // answers to them, for as long as the background jobs stay pending
    const items = [
      poke(1000),
      text(1100, 'Still running.'),
      end(1200),
      poke(4000),
      text(4100, 'Still running.'),
      end(4200),
    ];
    expect(lastOwnActivity(items)).toBeNull();
  });

  it('counts the work again once the poke’s turn has ended', () => {
    const items = [
      text(100),
      end(200),
      poke(1000),
      text(1100, 'Still running.'),
      end(1200),
      at(1300, { kind: 'tool_use', id: 't1', name: 'Bash', input: {} }),
      end(1400),
    ];
    expect(lastOwnActivity(items)).toBe(1400); // the turn after the poke is its own
    // and with only the poke after it, the last real work is what stands
    expect(lastOwnActivity(items.slice(0, 5))).toBe(200);
  });

  it('counts a turn the agent started by itself, and what it produced in it', () => {
    // a background job finished and Claude resumed: no user item at all
    const items = [
      at(500, { kind: 'system', text: 'resumed on its own' }),
      at(600, { kind: 'thinking', text: 'The job is done.' }),
      end(700),
    ];
    expect(lastOwnActivity(items)).toBe(700);
    // the system line alone is the harness talking, not the agent
    expect(lastOwnActivity(items.slice(0, 1))).toBeNull();
  });

  it('counts a permission it asked for, and an error it hit', () => {
    expect(
      lastOwnActivity([
        user(10),
        at(20, {
          kind: 'permission',
          requestId: 'r1',
          tool: 'Bash',
          title: 'rm -rf dist',
          input: {},
          options: [],
          decision: null,
        }),
      ]),
    ).toBe(20);
    expect(
      lastOwnActivity([user(10), at(30, { kind: 'error', message: 'boom' })]),
    ).toBe(30);
  });

  it('does not let a poke that is still running hide the work before it', () => {
    const items = [text(100), end(200), poke(1000), text(1100, 'Checking.')];
    expect(lastOwnActivity(items)).toBe(200);
  });
});
