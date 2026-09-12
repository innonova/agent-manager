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

/** The same reduction AgentsService applies: append, or replace the last item of the same kind. */
function run(adapter: ClaudeAdapter, records: LogRecord[]) {
  const items: Item[] = [];
  const states: AgentState[] = [];
  let conversationId: string | undefined;
  let error: string | undefined;
  for (const r of records) {
    const ing = adapter.ingest(r);
    if (ing.conversationId) conversationId = ing.conversationId;
    if (ing.updateLast) {
      const last = items[items.length - 1];
      if (last && last.kind === ing.updateLast.kind)
        items[items.length - 1] = ing.updateLast;
      else items.push(ing.updateLast);
    }
    items.push(...(ing.append ?? []));
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

  it('streams thinking text when a model exposes it', () => {
    const a = new ClaudeAdapter();
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
      append: [{ kind: 'thinking', text: 'Let me ' }],
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
      updateLast: { kind: 'thinking', text: 'Let me see.' },
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
      updateLast: { kind: 'thinking', text: 'Let me see.' },
      append: [],
    });
  });

  it('reports error results and error lines as the error state', () => {
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
    expect(r.append?.map((i) => i.kind)).toEqual(['error', 'turn_end']);
    const e = a.ingest(rec('out', { type: 'error', message: 'boom' }, 3));
    expect(e).toMatchObject({ state: 'error', error: 'boom' });
  });

  it('builds start, turn and interrupt lines', () => {
    const a = new ClaudeAdapter();
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
