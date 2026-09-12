import { FakeAdapter } from './fake.adapter.js';

const rec = (s: 'in' | 'out' | 'err', d: unknown, seq = 1) => ({
  seq,
  t: 0,
  s,
  d: typeof d === 'string' ? d : JSON.stringify(d),
});

describe('FakeAdapter', () => {
  it('maps the fake protocol onto items and states', () => {
    const a = new FakeAdapter();
    expect(
      a.ingest(rec('out', { type: 'init', conversationId: 'c1' })),
    ).toEqual({ conversationId: 'c1', state: 'idle' });
    expect(a.ingest(rec('in', { type: 'user', text: 'hi' }))).toEqual({
      state: 'working',
      append: [{ kind: 'user', text: 'hi' }],
    });
    expect(a.ingest(rec('out', { type: 'text_start' }))).toEqual({
      append: [{ kind: 'text', text: '', streaming: true }],
    });
    expect(a.ingest(rec('out', { type: 'text_delta', text: 'a ' }))).toEqual({
      updateLast: { kind: 'text', text: 'a ', streaming: true },
    });
    expect(a.ingest(rec('out', { type: 'text_delta', text: 'b' }))).toEqual({
      updateLast: { kind: 'text', text: 'a b', streaming: true },
    });
    expect(a.ingest(rec('out', { type: 'text_end' }))).toEqual({
      updateLast: { kind: 'text', text: 'a b', streaming: false },
    });
    expect(
      a.ingest(
        rec('out', {
          type: 'tool_use',
          id: 't1',
          name: 'Read',
          input: { x: 1 },
        }),
      ),
    ).toEqual({
      append: [{ kind: 'tool_use', id: 't1', name: 'Read', input: { x: 1 } }],
    });
    expect(
      a.ingest(rec('out', { type: 'tool_result', id: 't1', output: 'o' })),
    ).toEqual({
      append: [
        { kind: 'tool_result', toolUseId: 't1', output: 'o', isError: false },
      ],
    });
    expect(a.ingest(rec('out', { type: 'result', durationMs: 5 }))).toEqual({
      state: 'idle',
      append: [{ kind: 'turn_end', durationMs: 5, costUsd: 0 }],
    });
    expect(
      a.ingest(rec('out', { type: 'error', message: 'boom' })),
    ).toMatchObject({ state: 'error', error: 'boom' });
    expect(a.ingest(rec('err', 'agent-daemon: note'))).toEqual({
      append: [{ kind: 'system', text: 'agent-daemon: note' }],
    });
    expect(a.ingest(rec('out', 'not json'))).toEqual({
      append: [{ kind: 'system', text: 'not json' }],
    });
  });

  it('builds turn and resume arguments', () => {
    const a = new FakeAdapter();
    expect(a.turn('x')).toEqual([{ type: 'user', text: 'x' }]);
    expect(a.startArgs({ resume: null })).toEqual([]);
    expect(a.startArgs({ resume: 'c1' })).toEqual(['--resume', 'c1']);
  });
});
