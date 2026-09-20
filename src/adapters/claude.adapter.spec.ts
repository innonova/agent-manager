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
  it('a message steered mid-turn leaves the stream and a pending permission alone', () => {
    const records = load('tool-and-text.ndjson');
    const rec = (seq: number, d: unknown) => ({
      seq,
      t: 0,
      s: 'in' as const,
      d: JSON.stringify(d),
    });
    const steer = (seq: number) =>
      rec(seq, {
        type: 'user',
        message: { role: 'user', content: 'also this' },
      });
    // between two deltas of the first streamed text
    const deltas = records
      .map((r, k) => ({ r, k }))
      .filter(
        ({ r }) => /content_block_delta/.test(r.d) && /text_delta/.test(r.d),
      )
      .map(({ k }) => k);
    expect(deltas.length).toBeGreaterThan(1);
    const spliced = [...records];
    spliced.splice(deltas[0]! + 1, 0, steer(records[deltas[0]!]!.seq + 0.5));
    const plain = run(new ClaudeAdapter(), records);
    const steered = run(new ClaudeAdapter(), spliced);
    expect(steered.items.filter((i) => i.kind === 'user')).toHaveLength(
      plain.items.filter((i) => i.kind === 'user').length + 1,
    );
    // the texts are identical: the stream was not cut, nothing left marked streaming
    expect(steered.items.filter((i) => i.kind === 'text')).toEqual(
      plain.items.filter((i) => i.kind === 'text'),
    );
    expect(steered.items.some((i) => i.kind === 'text' && i.streaming)).toBe(
      false,
    );
    // with a permission pending, the steer's input does not report working
    const a = new ClaudeAdapter();
    run(
      a,
      load('permission.ndjson').filter((r) => r.seq <= 20),
    );
    if (a.pendingPermissions().length) {
      expect(a.ingest(steer(999)).state).toBe('waiting-permission');
    }
  });

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
    // the harness note rides on the system prompt, on a resume too
    expect(a.startArgs({ resume: 'abc', note: 'You run here.' })).toEqual([
      '--dangerously-skip-permissions',
      '--resume',
      'abc',
      '--append-system-prompt',
      'You run here.',
    ]);
    expect(
      a.startArgs({ resume: null, extraDirs: ['/r/ui', '/r/api'] }),
    ).toEqual([
      '--dangerously-skip-permissions',
      '--add-dir',
      '/r/ui',
      '--add-dir',
      '/r/api',
    ]);
    expect(a.turn('x')).toEqual([
      { type: 'user', message: { role: 'user', content: 'x' } },
    ]);
    expect(a.interrupt()[0]).toMatchObject({
      type: 'control_request',
      request: { subtype: 'interrupt' },
    });
  });

  it('a background job keeps the agent from looking ready, and the turn it triggers is a turn', () => {
    const { items, states } = run(
      new ClaudeAdapter(),
      load('background-task.ndjson'),
    );
    // working (our turn, then its init), idle at its result, working again when Claude resumes by itself, idle at the end
    expect(states).toEqual(['working', 'working', 'idle', 'working', 'idle']);
    expect(items.map((i) => i.kind)).toEqual([
      'user',
      'text',
      'system',
      'turn_end',
      'system',
      'system',
      'text',
      'turn_end',
    ]);
    const system = items.filter((i) => i.kind === 'system') as {
      text: string;
    }[];
    expect(system[0]!.text).toMatch(
      /^background task started: After three minutes/,
    );
    expect(system[1]!.text).toMatch(/^background task completed: /);
    expect(system[2]!.text).toBe('resumed on its own');
  });

  it('reports the number of pending background jobs as it changes', () => {
    const adapter = new ClaudeAdapter();
    const seen: number[] = [];
    for (const r of load('background-task.ndjson')) {
      const ing = adapter.ingest(r);
      if (ing.background !== undefined) seen.push(ing.background);
    }
    expect(seen).toEqual([1, 0]);
  });

  it('in ask mode a can_use_tool request waits for the human; our control_response settles it', () => {
    const adapter = new ClaudeAdapter();
    expect(adapter.startArgs({ permissions: 'ask' })).toEqual([
      '--permission-prompt-tool',
      'stdio',
    ]);
    expect(adapter.startArgs({})).toEqual(['--dangerously-skip-permissions']);
    const records = load('permission.ndjson');
    const { items, states } = run(adapter, records);
    expect(states).toContain('waiting-permission');
    const perm = items.find((i) => i.kind === 'permission') as any;
    expect(perm).toMatchObject({
      tool: 'Write',
      title: 'probe.txt',
      input: {
        file_path: expect.stringMatching(/probe\.txt$/),
        content: 'hello',
      },
      decision: 'allow', // the recording answered allow
    });
    expect(perm.options.map((o: any) => o.kind)).toEqual(['allow', 'deny']);
    // replaying up to the request only: it is pending, and decide() builds the answer
    const fresh = new ClaudeAdapter();
    const upTo = records.slice(
      0,
      records.findIndex(
        (r) => r.s === 'in' && r.d.includes('control_response'),
      ),
    );
    run(fresh, upTo);
    const [pending] = fresh.pendingPermissions();
    expect(pending).toBeTruthy();
    expect(fresh.decide(pending!.requestId, 'deny')).toEqual([
      {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: pending!.requestId,
          response: { behavior: 'deny', message: 'The user denied this.' },
        },
      },
    ]);
    expect(fresh.decide('nope', 'allow')).toBeNull();
    expect(fresh.decide(pending!.requestId, 'maybe')).toBeNull();
  });

  it('passes model and effort at start and reports the active model from init', () => {
    const adapter = new ClaudeAdapter();
    expect(
      adapter.startArgs({ model: 'claude-opus-5', effort: 'high' }),
    ).toEqual([
      '--dangerously-skip-permissions',
      '--model',
      'claude-opus-5',
      '--effort',
      'high',
    ]);
    const { items } = run(adapter, load('permission.ndjson').slice(0, 3));
    void items;
    const init = load('permission.ndjson').find((r) =>
      r.d.includes('"subtype":"init"'),
    )!;
    expect(new ClaudeAdapter().ingest(init).model).toBe(
      'claude-haiku-4-5-20251001',
    );
  });
});
