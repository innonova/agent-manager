import type { Item } from '../adapters/adapter.js';
import {
  due,
  lastTurn,
  NUDGE_MARK,
  nudgeText,
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
    // and is asked for what the message leaves open, in the agent's words
    expect(input).toContain('"open": [');
  });

  it('is read leniently, and an answer that cannot be read means the agent is asked', () => {
    expect(
      parseReading(
        'Sure:\n```json\n{"verdict": "needs_person", "why": "Asks whether xcom.innonova.ch should redirect."}\n```',
      ),
    ).toEqual({
      verdict: 'needs_person',
      why: 'Asks whether xcom.innonova.ch should redirect.',
      open: [],
    });
    expect(parseReading('{"verdict":"done","why":"x"}').verdict).toBe('done');
    expect(parseReading('I think it is fine.')).toEqual({
      verdict: 'paused',
      why: 'it is not clear why it stopped',
      open: [],
    });
    expect(parseReading('{"verdict":"maybe"}').verdict).toBe('paused');
    // what it leaves open: strings only, tidied, no more than eight
    expect(
      parseReading(
        JSON.stringify({
          verdict: 'paused',
          why: 'open items',
          open: [' night maps:\n fog has no effect ', 7, '', 'rain is missing'],
        }),
      ).open,
    ).toEqual(['night maps: fog has no effect', 'rain is missing']);
    expect(
      parseReading(
        JSON.stringify({
          verdict: 'paused',
          why: 'x',
          open: Array.from({ length: 12 }, (_, i) => `item ${i}`),
        }),
      ).open,
    ).toHaveLength(8);
    expect(
      parseReading('{"verdict":"paused","why":"x","open":"all"}').open,
    ).toEqual([]);
  });
});

describe('when a nudge is due', () => {
  const rules = { restMs: 30 * MIN, maxInRow: 3 };
  it('always at the first stop after a person wrote, at once', () => {
    expect(due(null, 1000, rules)).toEqual({
      ok: true,
      inRow: 1,
      notBefore: 0,
    });
    expect(due({ at: 1000, inRow: 3 }, 2000, rules)).toEqual({
      ok: true,
      inRow: 1,
      notBefore: 0,
    });
  });
  it('after a nudge, again, and no sooner than half an hour after it', () => {
    // it took up one item for ten minutes and stopped: that is no reason never to ask again
    expect(due({ at: 1000, inRow: 1 }, 500, rules)).toEqual({
      ok: true,
      inRow: 2,
      notBefore: 1000 + 30 * MIN,
    });
  });
  it('and not for ever: a number of nudges in a row without a word from a person is the end', () => {
    expect(due({ at: 1000, inRow: 3 }, null, rules)).toEqual({
      ok: false,
      why: 'it has been asked 3 times in a row without a word from a person',
    });
  });
});

describe('the nudge', () => {
  it("shows the agent, in the manager's name, what it left open in its own words, and asks which of it needs the person", () => {
    const text = nudgeText(
      ['Night maps: fog has no effect', 'the navigation map, one level deeper'],
      8 * 60 * MIN,
    );
    expect(text.startsWith(NUDGE_MARK)).toBe(true);
    expect(text).toContain('Nobody has written to you for 8 hours.');
    expect(text).toContain(
      'Your last message leaves this open, in your words:\n- Night maps: fog has no effect\n- the navigation map, one level deeper\n',
    );
    expect(text).toContain('Which of it needs the person, and for what?');
    expect(text).toContain('am say --question');
    // the way out asks for a reason for each, and is still a way out
    expect(text).toContain('say for each of these why it is not');
    expect(text).toContain('you are not asked again until they write');
    // no order to continue
    expect(text).not.toMatch(
      /\b(must|continue working|keep going|do not stop)\b/i,
    );
  });
  it('asks what is left when the message did not say, and says nothing of a person who never wrote', () => {
    const text = nudgeText([], null);
    expect(text.startsWith(NUDGE_MARK)).toBe(true);
    expect(text).not.toContain('Nobody has written to you for');
    expect(text).toContain('Your last message does not say what is left.');
    expect(text).toContain('say so in a line');
    expect(nudgeText([], 5 * MIN)).toContain('for 5 minutes.');
    expect(nudgeText([], 3 * 24 * 60 * MIN)).toContain('for 3 days.');
  });
});
