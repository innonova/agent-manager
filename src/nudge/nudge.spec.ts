import type { Item } from '../adapters/adapter.js';
import {
  due,
  lastTurn,
  NUDGE_MARK,
  NUDGE_TEXT,
  parseReading,
  readerInput,
} from './nudge.js';

const items = (list: Item[]) => list.map((item) => ({ item }));
const user = (text: string, by = 'aek'): Item => ({ kind: 'user', text, by });
const text = (t: string): Item => ({ kind: 'text', text: t, streaming: false });
const sys = (t: string): Item => ({ kind: 'system', text: t });
const MIN = 60_000;

describe('lastTurn', () => {
  it("finds the turn's last text and what the person last wrote", () => {
    expect(
      lastTurn(
        items([
          user('convert the maps'),
          text('Converting.'),
          { kind: 'turn_end' },
          user('a background job finished', 'manager'),
          text('Two maps are done.'),
          { kind: 'tool_use', id: 't', name: 'Bash', input: {} },
          text('All maps converted. Next: the doors.'),
          { kind: 'turn_end' },
        ]),
      ),
    ).toEqual({
      text: 'All maps converted. Next: the doors.',
      stoppedByPerson: false,
      asked: 'convert the maps',
    });
  });

  it('sees that a person stopped the turn, or took its message back', () => {
    expect(
      lastTurn(
        items([
          user('go'),
          text('Working.'),
          sys('interrupt requested'),
          { kind: 'turn_end' },
        ]),
      ).stoppedByPerson,
    ).toBe(true);
    expect(
      lastTurn(
        items([
          user('go'),
          text('x'),
          sys('withdrawn: "go"'),
          { kind: 'turn_end' },
        ]),
      ).stoppedByPerson,
    ).toBe(true);
    // one it resumed by itself: the turn begins there, an earlier stop is not this turn's
    expect(
      lastTurn(
        items([
          user('go'),
          sys('interrupt requested'),
          { kind: 'turn_end' },
          sys('resumed on its own'),
          text('The job finished.'),
          { kind: 'turn_end' },
        ]),
      ),
    ).toEqual({
      text: 'The job finished.',
      stoppedByPerson: false,
      asked: 'go',
    });
  });
});

describe('the reader of last messages', () => {
  it('is given the message, what the person last wrote, and three verdicts to choose from', () => {
    const input = readerInput({
      text: 'Doors work. Remaining: sandbags, the sedan.',
      stoppedByPerson: false,
      asked: 'fix the doors',
    });
    expect(input).toContain('<person>\nfix the doors\n</person>');
    expect(input).toContain(
      '<agent>\nDoors work. Remaining: sandbags, the sedan.\n</agent>',
    );
    expect(input).toContain('"verdict": "<needs_person|done|paused>"');
  });

  it('is read leniently, and an answer that cannot be read means the agent is asked', () => {
    expect(
      parseReading(
        'Sure:\n```json\n{"verdict": "needs_person", "why": "Asks whether xcom.innonova.ch should redirect."}\n```',
      ),
    ).toEqual({
      verdict: 'needs_person',
      why: 'Asks whether xcom.innonova.ch should redirect.',
    });
    expect(parseReading('{"verdict":"done","why":"x"}').verdict).toBe('done');
    expect(parseReading('I think it is fine.')).toEqual({
      verdict: 'paused',
      why: 'it is not clear why it stopped',
    });
    expect(parseReading('{"verdict":"maybe"}').verdict).toBe('paused');
  });
});

describe('when a nudge is due', () => {
  const rules = { workMs: 30 * MIN, maxInRow: 3 };
  it('always at the first stop after a person wrote, however short the work', () => {
    expect(due(null, 1000, 0, rules)).toEqual({ ok: true, inRow: 1 });
    expect(due({ at: 1000, inRow: 3 }, 2000, 0, rules)).toEqual({
      ok: true,
      inRow: 1,
    });
  });
  it('after a nudge, only once the agent has worked half an hour more', () => {
    // it answered in a minute: it cannot do more, and is left alone
    expect(due({ at: 1000, inRow: 1 }, 500, MIN, rules)).toEqual({
      ok: false,
      why: 'it has worked 1 min since it was last asked',
    });
    expect(due({ at: 1000, inRow: 1 }, 500, 31 * MIN, rules)).toEqual({
      ok: true,
      inRow: 2,
    });
  });
  it('and not for ever: a number of nudges in a row without a word from a person is the end', () => {
    expect(due({ at: 1000, inRow: 3 }, null, 60 * MIN, rules)).toEqual({
      ok: false,
      why: 'it has been asked 3 times in a row without a word from a person',
    });
  });
});

describe('the nudge', () => {
  it("is a question in the manager's name with three answers, and says it is no instruction", () => {
    expect(NUDGE_TEXT.startsWith(NUDGE_MARK)).toBe(true);
    expect(NUDGE_TEXT).toContain('carry on with it');
    expect(NUDGE_TEXT).toContain('they will be paged');
    expect(NUDGE_TEXT).toContain('The work is done');
    expect(NUDGE_TEXT).toContain('a question, not an instruction to continue');
  });
});
