import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentState, Item } from './adapter.js';
import { ClaudeAdapter } from './claude.adapter.js';
import type { LogRecord } from '../daemon/daemon-client.js';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../test/fixtures/claude',
);

/** The same reduction AgentsService applies: append, or replace the item under the op's key. */
function run(adapter: ClaudeAdapter, records: LogRecord[]) {
  const items: Item[] = [];
  const keys = new Map<string, number>();
  const states: AgentState[] = [];
  let conversationId: string | undefined;
  let error: string | undefined;
  for (const r of records) {
    const ing = adapter.ingest(r);
    if (ing.conversationId) conversationId = ing.conversationId;
    for (const op of ing.ops ?? []) {
      if (op.op === 'update' && keys.has(op.key)) {
        items[keys.get(op.key)!] = op.item;
        continue;
      }
      items.push(op.item);
      if (op.key) keys.set(op.key, items.length - 1);
    }
    if (ing.state) states.push(ing.state);
    if (ing.error) error = ing.error;
  }
  return { items, states, conversationId, error };
}

function load(name: string): LogRecord[] {
  return fs
    .readFileSync(path.join(FIXTURES, name), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as LogRecord);
}

const rec = (s: 'in' | 'out', d: unknown, seq: number): LogRecord => ({
  seq,
  t: 0,
  s,
  d: JSON.stringify(d),
});
const ev = (event: unknown) => ({ type: 'stream_event', event });

describe('ClaudeAdapter', () => {
  it('turns a recorded two-turn session with a tool call into items', () => {
    const { items, states, conversationId, error } = run(
      new ClaudeAdapter(),
      load('tool-and-text.ndjson'),
    );
    expect(error).toBeUndefined();
    expect(conversationId).toMatch(/^[0-9a-f-]{36}$/);
    // this recording's thinking blocks carry only signatures, so no thinking items
    expect(items.map((i) => i.kind)).toEqual([
      'user',
      'tool_use',
      'tool_result',
      'text',
      'turn_end',
      'user',
      'text',
      'turn_end',
    ]);
    const tool = items[1] as Extract<Item, { kind: 'tool_use' }>;
    expect(tool.name).toBe('Read');
    expect((tool.input as { file_path: string }).file_path).toMatch(
      /example\.txt$/,
    );
    const result = items[2] as Extract<Item, { kind: 'tool_result' }>;
    expect(result.toolUseId).toBe(tool.id);
    expect(result.output).toContain('hello fixture');
    expect(result.isError).toBe(false);
    const text1 = items[3] as Extract<Item, { kind: 'text' }>;
    expect(text1.streaming).toBe(false);
    expect(text1.text.trim()).toBe('hello fixture');
    expect((items[6] as Extract<Item, { kind: 'text' }>).text.trim()).toBe(
      'PONG',
    );
    const end = items[4] as Extract<Item, { kind: 'turn_end' }>;
    expect(typeof end.costUsd).toBe('number');
    expect(typeof end.durationMs).toBe('number');
    // working on the user line, working again on init, idle on result; twice
    expect(states).toEqual([
      'working',
      'working',
      'idle',
      'working',
      'working',
      'idle',
    ]);
  });

  it('streams text deltas into one growing item before the full message replaces it', () => {
    const records = load('tool-and-text.ndjson');
    const upTo = run(
      new ClaudeAdapter(),
      records.filter((r) => r.seq <= 39),
    ); // first text delta of turn 1
    const last = upTo.items[upTo.items.length - 1] as Extract<
      Item,
      { kind: 'text' }
    >;
    expect(last.kind).toBe('text');
    expect(last.streaming).toBe(true);
    expect(last.text.length).toBeGreaterThan(0);
  });

  it('streams thinking text when a model exposes it, under a stable key', () => {
    const a = new ClaudeAdapter();
    a.ingest(rec('out', ev({ type: 'message_start' }), 0));
    expect(
      a.ingest(
        rec(
          'out',
          ev({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: '' },
          }),
          1,
        ),
      ),
    ).toEqual({});
    expect(
      a.ingest(
        rec(
          'out',
          ev({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'Let me ' },
          }),
          2,
        ),
      ),
    ).toEqual({
      ops: [
        {
          op: 'update',
          key: 'm1b0',
          item: { kind: 'thinking', text: 'Let me ' },
        },
      ],
    });
    expect(
      a.ingest(
        rec(
          'out',
          ev({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'see.' },
          }),
          3,
        ),
      ),
    ).toEqual({
      ops: [
        {
          op: 'update',
          key: 'm1b0',
          item: { kind: 'thinking', text: 'Let me see.' },
        },
      ],
    });
    expect(
      a.ingest(
        rec(
          'out',
          {
            type: 'assistant',
            message: {
              content: [
                { type: 'thinking', thinking: 'Let me see.', signature: 'x' },
              ],
            },
          },
          4,
        ),
      ),
    ).toEqual({
      ops: [
        {
          op: 'update',
          key: 'm1b0',
          item: { kind: 'thinking', text: 'Let me see.' },
        },
      ],
    });
  });

  it('appends consecutive text blocks in order when nothing was streamed', () => {
    const a = new ClaudeAdapter();
    const one = a.ingest(
      rec(
        'out',
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'one' }] },
        },
        1,
      ),
    );
    const two = a.ingest(
      rec(
        'out',
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'two' }] },
        },
        2,
      ),
    );
    expect(one.ops).toEqual([
      { op: 'append', item: { kind: 'text', text: 'one', streaming: false } },
    ]);
    expect(two.ops).toEqual([
      { op: 'append', item: { kind: 'text', text: 'two', streaming: false } },
    ]);
  });

  it('keeps a streamed text item addressable across an interleaved stderr line', () => {
    const { items } = run(new ClaudeAdapter(), [
      rec('out', ev({ type: 'message_start' }), 1),
      rec(
        'out',
        ev({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
        2,
      ),
      rec(
        'out',
        ev({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hel' },
        }),
        3,
      ),
      { seq: 4, t: 0, s: 'err', d: 'warning from claude' },
      rec(
        'out',
        ev({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'lo' },
        }),
        5,
      ),
      rec(
        'out',
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'hello' }] },
        },
        6,
      ),
    ]);
    expect(items).toEqual([
      { kind: 'text', text: 'hello', streaming: false },
      { kind: 'system', text: 'warning from claude' },
    ]);
  });

  it('reports error results and error lines as the error state, preferring the documented errors array', () => {
    const a = new ClaudeAdapter();
    a.ingest(
      rec('in', { type: 'user', message: { role: 'user', content: 'hi' } }, 1),
    );
    const r = a.ingest(
      rec(
        'out',
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: 'usage limit reached',
          session_id: 's1',
        },
        2,
      ),
    );
    expect(r).toMatchObject({
      state: 'error',
      error: 'usage limit reached',
      conversationId: 's1',
    });
    expect(r.ops?.map((o) => o.item.kind)).toEqual(['error', 'turn_end']);
    const documented = a.ingest(
      rec(
        'out',
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: ['specific failure'],
          session_id: 's1',
        },
        3,
      ),
    );
    expect(documented).toMatchObject({
      state: 'error',
      error: 'specific failure',
    });
    const e = a.ingest(rec('out', { type: 'error', message: 'boom' }, 4));
    expect(e).toMatchObject({ state: 'error', error: 'boom' });
  });

  it('builds start, turn and interrupt lines and is ready as soon as it runs', () => {
    const a = new ClaudeAdapter();
    expect(a.initialState).toBe('idle');
    expect(a.startArgs({ resume: null })).toEqual([
      '--dangerously-skip-permissions',
    ]);
    expect(a.startArgs({ resume: 'abc' })).toEqual([
      '--dangerously-skip-permissions',
      '--resume',
      'abc',
    ]);
    expect(a.turn('x')).toEqual([
      { type: 'user', message: { role: 'user', content: 'x' } },
    ]);
    expect(a.interrupt()[0]).toMatchObject({
      type: 'control_request',
      request: { subtype: 'interrupt' },
    });
  });
});
