import type { Item } from '../adapters/adapter.js';
import {
  classifierInput,
  DialogChat,
  DialogItem,
  Exchange,
  exchangesOf,
  exchangeTokens,
  fitClassifier,
  parseWeights,
  renderExchange,
  renderFiles,
  renderIndex,
  renderNotice,
  select,
  Weight,
  within,
} from './dialog.js';

const items = (list: Item[], t0 = 1_000): DialogItem[] =>
  list.map((item, index) => ({ index, at: t0 + index * 1000, item }));
const user = (text: string, by = 'aek'): Item => ({ kind: 'user', text, by });
const text = (t: string): Item => ({ kind: 'text', text: t, streaming: false });
const long = (start: string) =>
  `${start} ${'because of the reasons. '.repeat(20)}`;

describe('exchangesOf', () => {
  it('pairs what the person wrote with what the agent wrote back, leaving tool calls and progress lines out', () => {
    const ex = exchangesOf(
      items([
        text('before anyone spoke'),
        user('make the logo teal'),
        text('Looking at the palette.'), // a progress line: short, with more after it
        { kind: 'tool_use', id: 't1', name: 'Read', input: {} },
        { kind: 'tool_result', toolUseId: 't1', output: 'x', isError: false },
        text(long('Teal it is, and the wordmark stays lowercase')),
        { kind: 'turn_end' },
        user('good'),
        user('and the favicon too'),
        text('Done.'),
        { kind: 'turn_end' },
        user('/compact keep the decisions'), // a command to the CLI: not something said
        { kind: 'turn_end' },
      ]),
    );
    expect(ex.map((e) => e.n)).toEqual([1, 2]);
    expect(ex[0]).toMatchObject({ by: 'aek', person: 'make the logo teal' });
    expect(ex[0]!.agent).toBe(
      long('Teal it is, and the wordmark stays lowercase').trim(),
    );
    // two messages with nothing between them are one exchange; a short reply that is all there is, is kept
    expect(ex[1]).toMatchObject({
      person: 'good\n\nand the favicon too',
      agent: 'Done.',
    });
  });

  it("leaves the manager's own turns out, and still counts what the agent wrote after one", () => {
    const ex = exchangesOf(
      items([
        user('run the suite in the background'),
        text('Started.'),
        { kind: 'turn_end' },
        user('a background job finished', 'manager'),
        text(long('The suite passed, 34 of 34')),
      ]),
    );
    expect(ex).toHaveLength(1);
    // a short line that ended a turn is what the person was left with: kept
    expect(ex[0]!.agent).toMatch(/^Started\.\n\nThe suite passed/);
  });

  it('keeps the number of an exchange that was taken back, and none of its text in what follows', () => {
    const ex = exchangesOf(
      items([
        user('first'),
        text('ok one'),
        { kind: 'turn_end' },
        user('nonsense, sent too early'),
        text('answering the nonsense'),
        { kind: 'system', text: 'withdrawn', withdrawnFrom: 3 },
        user('what I meant'),
        text('ok three'),
      ]),
    );
    expect(ex.map((e) => [e.n, e.withdrawn, e.agent])).toEqual([
      [1, false, 'ok one'],
      [2, true, ''],
      [3, false, 'ok three'],
    ]);
  });

  it('does not take a progress line for an answer when a message arrives in the middle of a turn', () => {
    const ex = exchangesOf(
      items([
        user('convert the maps'),
        text('Converting the first map.'),
        user('i am off to sleep, keep going until 7'), // a steer: the turn goes on
        text('The import is a quarter done.'),
        user('it was not a quarter, the bar is indeterminate'),
        text('Right, waiting for it to finish.'),
        text(long('Morning report: all maps converted')),
        { kind: 'turn_end' },
      ]),
    );
    expect(ex.map((e) => e.agent.slice(0, 14))).toEqual([
      '',
      '',
      'Morning report',
    ]);
  });

  it('weaves the chat in by time: an aside opens an exchange, what the agent said there is its side', () => {
    const chat: DialogChat[] = [
      {
        at: 3_500,
        from: 'person',
        author: 'aek',
        kind: 'message',
        text: 'use the old port',
        via: 'aside',
      },
      {
        at: 4_500,
        from: 'agent',
        author: 'claude',
        kind: 'decision',
        text: 'Port 4268 kept.',
        via: null,
      },
      // sent from the chat pane as a turn: the transcript has it already
      {
        at: 5_000,
        from: 'person',
        author: 'aek',
        kind: 'message',
        text: 'go on',
        via: 'turn',
      },
    ];
    const ex = exchangesOf(
      items([
        user('start'),
        text('working'),
        { kind: 'turn_end' },
        { kind: 'turn_end' },
        { kind: 'turn_end' },
        user('go on'),
        text('going'),
      ]),
      chat,
    );
    expect(ex.map((e) => [e.person, e.agent])).toEqual([
      ['start', 'working'],
      [
        '[in the chat] use the old port',
        '[in the chat, a decision] Port 4268 kept.',
      ],
      ['go on', 'going'],
    ]);
  });
});

const exchange = (n: number, chars: number, withdrawn = false): Exchange => ({
  n,
  at: Date.UTC(2026, 8, 12) + n * 86_400_000,
  by: 'aek',
  person: `message ${n}`,
  agent: 'x'.repeat(chars),
  parts: ['x'.repeat(chars)],
  withdrawn,
});
const weight = (n: number, w: number, over: Partial<Weight> = {}): Weight => ({
  n,
  kind: 'decision',
  weight: w,
  inForce: true,
  supersededBy: null,
  line: `line ${n}`,
  ...over,
});

describe('select', () => {
  const all = Array.from({ length: 10 }, (_, i) => exchange(i + 1, 3_000)); // about 870 tokens each
  const cost = exchangeTokens(all[0]!);

  it('takes the most recent up to half the budget, then the heaviest older ones still in force', () => {
    const weights = new Map(
      [
        weight(1, 3),
        weight(2, 1),
        weight(3, 3, { inForce: false }),
        weight(4, 2),
        weight(5, 3, { supersededBy: 9, inForce: false }),
        weight(6, 2),
      ].map((w) => [w.n, w]),
    );
    const sel = select(all, weights, cost * 8);
    expect(sel.recent.map((e) => e.n)).toEqual([7, 8, 9, 10]); // half of eight
    // room for three more under nine tenths: the 3 first, then the 2s, newest first
    expect(sel.kept.map((e) => e.n)).toEqual([1, 4, 6]);
    expect(sel.indexed.map((e) => e.n)).toEqual([2, 3, 5]);
  });

  it('fills what is left of the budget with lighter exchanges still in force: rules before decisions before open tasks', () => {
    const weights = new Map(
      [
        weight(1, 1, { kind: 'task' }),
        weight(2, 1, { kind: 'decision' }),
        weight(3, 1, { kind: 'rule' }),
        weight(4, 1, { kind: 'chatter' }),
        weight(5, 0),
        weight(6, 1, { kind: 'rule', inForce: false }),
      ].map((w) => [w.n, w]),
    );
    // four recent, then room for two more under nine tenths of eight
    const sel = select(all, weights, cost * 7);
    expect(sel.recent.map((e) => e.n)).toEqual([8, 9, 10]);
    expect(sel.kept.map((e) => e.n)).toEqual([1, 2, 3]);
    expect(select(all, weights, cost * 6).kept.map((e) => e.n)).toEqual([2, 3]);
  });

  it('hands a very long exchange back with its latest texts, whole ones, and says what it leaves out', () => {
    const night: Exchange = {
      ...exchange(3, 0),
      parts: [
        'first report '.repeat(300),
        'second '.repeat(300),
        'morning report '.repeat(40),
      ],
    };
    night.agent = night.parts.join('\n\n');
    const list = [exchange(1, 100), exchange(2, 100), night, exchange(4, 100)];
    // an eighth of the budget is less than the night's reports: the last two fit, the first does not
    const sel = select(list, new Map(), 12_000);
    expect(sel.recent.map((e) => e.n)).toEqual([1, 2, 3, 4]);
    const back = sel.recent[2]!;
    expect(back.parts).toEqual([night.parts[1], night.parts[2]]);
    expect(back.left).toEqual({ texts: 1, tokens: 1365 });
    expect(renderExchange(back)).toContain(
      'You:\n[1 earlier text of yours in this exchange is not shown here, about 1,365 tokens; `am recall 3` prints all of it]\n\nsecond ',
    );
    // the last text always comes, however long
    expect(within(night, 10).parts).toEqual([night.parts[2]]);
    expect(within(exchange(9, 50_000), 10).left).toBeUndefined(); // one text: nothing to leave out
  });

  it('hands back the last two whatever they cost, and never one that was taken back', () => {
    const list = [
      exchange(1, 100),
      exchange(2, 100, true),
      exchange(3, 90_000),
      exchange(4, 90_000),
    ];
    const sel = select(list, new Map(), 1_000);
    expect(sel.recent.map((e) => e.n)).toEqual([3, 4]);
    expect(sel.indexed.map((e) => e.n)).toEqual([1]);
    expect(sel.kept).toEqual([]);
  });
});

describe('what the agent reads back', () => {
  it('lists every exchange not handed back: what it settled, whether it still stands, runs of nothing folded', () => {
    const weights = new Map(
      [
        weight(1, 0, { kind: 'chatter', inForce: false }),
        weight(2, 0, { kind: 'chatter', inForce: false }),
        weight(3, 1, { kind: 'task', inForce: false }),
        weight(4, 3, { supersededBy: 7, inForce: false }),
        weight(6, 0, { kind: 'chatter', inForce: false }),
      ].map((w) => [w.n, w]),
    );
    expect(
      renderIndex(
        [1, 2, 3, 4, 5, 6].map((n) => exchange(n, 10)),
        weights,
      ),
    ).toEqual([
      '#1 to #2: nothing to keep (acknowledgements, status questions)',
      '#3 2026-09-15 task: line 3 (done)',
      '#4 2026-09-16 decision: line 4 (reversed by #7)',
      '#5 2026-09-17 (not weighed yet) message 5',
      '#6: nothing to keep (acknowledgements, status questions)',
    ]);
  });

  it('writes files no read has to page through, exchanges whole, the index first and the recent last', () => {
    const sel = {
      recent: [exchange(9, 40_000), exchange(10, 100)],
      kept: [exchange(2, 30_000)],
      indexed: [exchange(1, 10)],
      tokens: 0,
    };
    const files = renderFiles(sel, new Map([[1, weight(1, 1)]]));
    expect(files).toHaveLength(2);
    expect(files[0]).toContain('(file 1 of 2)');
    expect(files[0]!.indexOf('#1 2026-09-13 decision: line 1')).toBeGreaterThan(
      0,
    );
    expect(files[0]).toContain(
      '### #2 · 2026-09-14 00:00 UTC\naek:\nmessage 2\n\nYou:\n',
    );
    expect(files[0]).not.toContain('### #9');
    expect(files[1]).toContain('## The most recent exchanges, word for word');
    expect(files[1]!.indexOf('### #9')).toBeLessThan(
      files[1]!.indexOf('### #10'),
    );
    for (const f of files) expect(f.length).toBeLessThan(70_000);
    const notice = renderNotice(['/d/dialog-1.md', '/d/dialog-2.md'], sel);
    expect(notice).toContain('/d/dialog-1.md\n/d/dialog-2.md');
    expect(notice).toContain('3 exchanges are there word for word');
    expect(notice).toContain('`am recall <number>`');
    expect(notice.length).toBeLessThan(10_000); // Claude Code's cap on a hook's text
  });
});

describe('the classifier', () => {
  it('is given every exchange that was not taken back, numbered as they are', () => {
    const input = classifierInput([
      exchange(1, 5),
      exchange(2, 5, true),
      exchange(3, 5),
    ]);
    expect(input).toContain(
      '2 exchanges. Output one JSON line per exchange, 2 lines.',
    );
    expect(input).toContain(
      '=== exchange 1 (2026-09-13 00:00 UTC)\nPERSON (aek):\nmessage 1\n\nAGENT:\nxxxxx',
    );
    expect(input).not.toContain('=== exchange 2');
    expect(input).toContain('=== exchange 3');
  });

  it('takes all of a dialog while it fits, and otherwise leaves out the oldest exchanges found light before', () => {
    const list = [1, 2, 3, 4].map((n) => exchange(n, 1_000));
    const weights = new Map(
      [weight(1, 0), weight(2, 3), weight(3, 1)].map((w) => [w.n, w]),
    );
    expect(fitClassifier(list, weights).map((e) => e.n)).toEqual([1, 2, 3, 4]);
    expect(fitClassifier(list, weights, 3_500).map((e) => e.n)).toEqual([
      2, 3, 4,
    ]);
    expect(fitClassifier(list, weights, 2_500).map((e) => e.n)).toEqual([2, 4]);
    // what was never weighed, or weighs something, cannot be left out
    expect(() => fitClassifier(list, weights, 1_500)).toThrow(/too long/);
  });

  it('is read leniently: prose around the lines, a fence, a number it was not asked about', () => {
    const got = parseWeights(
      [
        'Here are the lines:',
        '```json',
        '{"id": 1, "kind": "rule", "in_force": true, "weight": 3, "superseded_by": null, "line": "Never restart the daemon."}',
        '{"id": 2, "kind": "decision", "in_force": true, "weight": 3, "superseded_by": 3, "line": "Withdraw refuses when files changed."},',
        '{"id": 3, "kind": "nonsense", "weight": 9, "line": "Withdraw never refuses."}',
        '{"id": 99, "kind": "task", "in_force": true, "weight": 2, "superseded_by": null, "line": "not an exchange"}',
        '{"id": 4, "kind": "chatter", "weight": "x"',
        '```',
      ].join('\n'),
      new Set([1, 2, 3, 4]),
    );
    expect(got).toEqual([
      {
        n: 1,
        kind: 'rule',
        weight: 3,
        inForce: true,
        supersededBy: null,
        line: 'Never restart the daemon.',
      },
      // named as reversed: not in force, whatever the line itself claimed
      {
        n: 2,
        kind: 'decision',
        weight: 3,
        inForce: false,
        supersededBy: 3,
        line: 'Withdraw refuses when files changed.',
      },
      {
        n: 3,
        kind: 'decision',
        weight: 3,
        inForce: true,
        supersededBy: null,
        line: 'Withdraw never refuses.',
      },
    ]);
  });
});
