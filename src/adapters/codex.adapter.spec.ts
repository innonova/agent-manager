import type { Item } from './adapter.js';
import { CodexAdapter } from './codex.adapter.js';
import { loadFixture, replay } from './replay-harness.js';

describe('CodexAdapter', () => {
  it('drives the handshake from the replies', () => {
    const a = new CodexAdapter();
    const start = a.startLines({ cwd: '/w', resume: null }) as any[];
    expect(start).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: {
            name: 'agent-manager',
            title: 'agent-manager',
            version: '0.0.1',
          },
        },
      },
    ]);
    const { sent, states } = replay(
      a,
      loadFixture('codex', 'tool-and-text.ndjson').filter((r) => r.seq <= 6),
    );
    expect(sent.map((s) => s.line.method)).toEqual([
      'initialized',
      'thread/start',
    ]);
    expect(sent[1].line.params).toEqual({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
    expect(states).toEqual(['idle']);
  });

  it('resumes an existing thread instead of starting one', () => {
    const a = new CodexAdapter();
    a.startLines({ cwd: '/w', resume: 'thread-1' });
    const { sent } = replay(
      a,
      loadFixture('codex', 'tool-and-text.ndjson').filter((r) => r.seq <= 2),
    );
    expect(sent[1].line).toMatchObject({
      method: 'thread/resume',
      params: { threadId: 'thread-1', approvalPolicy: 'never' },
    });
  });

  it('turns the recorded two-turn session with a command into items', () => {
    const a = new CodexAdapter();
    a.startLines({ cwd: '/w', resume: null });
    const { items, states, conversationId, error } = replay(
      a,
      loadFixture('codex', 'tool-and-text.ndjson'),
    );
    expect(error).toBeUndefined();
    expect(conversationId).toMatch(/^01a0962d/);
    expect(items.map((i) => i.kind)).toEqual([
      'user',
      'text',
      'tool_use',
      'tool_result',
      'tool_use',
      'tool_result',
      'text',
      'turn_end',
      'user',
      'text',
      'turn_end',
    ]);
    expect((items[0] as any).text).toContain('cat note.txt');
    const intro = items[1] as Extract<Item, { kind: 'text' }>;
    expect(intro.streaming).toBe(false);
    expect(intro.text).toContain('read note.txt');
    const tool = items[2] as Extract<Item, { kind: 'tool_use' }>;
    expect(tool.name).toBe('shell');
    expect((tool.input as any).command).toContain('cat note.txt');
    const result = items[3] as Extract<Item, { kind: 'tool_result' }>;
    expect(result.toolUseId).toBe(tool.id);
    expect(result.output).toContain('alpha');
    expect(result.isError).toBe(false);
    expect((items[6] as any).text).toBe('DONE');
    expect((items[9] as any).text).toBe('PONG');
    expect(states).toEqual([
      'idle',
      'working',
      'working',
      'idle',
      'working',
      'working',
      'idle',
    ]);
    expect(a.turnInProgress()).toBe(false);
  });

  it('builds turn and interrupt lines once the thread is known', () => {
    const a = new CodexAdapter();
    a.startLines({ cwd: '/w', resume: null });
    expect(a.turn('x')).toEqual([]); // no thread yet
    replay(
      a,
      loadFixture('codex', 'tool-and-text.ndjson').filter((r) => r.seq <= 12),
    );
    const turn = a.turn('hello') as any[];
    expect(turn[0]).toMatchObject({
      method: 'turn/start',
      params: { input: [{ type: 'text', text: 'hello' }] },
    });
    expect(turn[0].params.threadId).toMatch(/^01a0962d/);
    expect(a.interrupt()[0]).toMatchObject({ method: 'turn/interrupt' });
    expect(a.turnInProgress()).toBe(true);
  });

  it('reports a failed turn and a protocol error as the error state', () => {
    const a = new CodexAdapter();
    const rec = (s: 'in' | 'out', d: unknown, seq: number) => ({
      seq,
      t: 0,
      s,
      d: JSON.stringify(d),
    });
    expect(
      a.ingest(
        rec(
          'out',
          {
            method: 'turn/completed',
            params: { turn: { status: 'failed', error: { message: 'boom' } } },
          },
          1,
        ),
      ),
    ).toMatchObject({ state: 'error', error: 'boom' });
    expect(
      a.ingest(
        rec(
          'out',
          {
            method: 'error',
            params: { error: { message: 'usage limit' }, willRetry: false },
          },
          2,
        ),
      ),
    ).toMatchObject({ state: 'error', error: 'usage limit' });
    a.ingest(
      rec(
        'in',
        {
          jsonrpc: '2.0',
          id: 7,
          method: 'turn/start',
          params: { threadId: 't', input: [{ type: 'text', text: 'hi' }] },
        },
        3,
      ),
    );
    expect(
      a.ingest(
        rec(
          'out',
          { jsonrpc: '2.0', id: 7, error: { message: 'thread gone' } },
          4,
        ),
      ),
    ).toMatchObject({ state: 'error', error: 'thread gone' });
  });

  it('a command backgrounded past the turn is a pending job until its item completes', () => {
    const { items, states, backgrounds } = replay(
      new CodexAdapter(),
      loadFixture('codex', 'background-command.ndjson'),
    );
    expect(states[0]).toBe('idle');
    expect(states).toContain('working');
    expect(states[states.length - 1]).toBe('idle');
    expect(backgrounds).toEqual([1, 0]); // one open command at turn end; none once it completes
    const kinds = items.map((i) => i.kind);
    expect(kinds.indexOf('tool_result')).toBeGreaterThan(
      kinds.indexOf('turn_end'),
    );
    const result = items.find((i) => i.kind === 'tool_result') as {
      output: string;
    };
    expect(result.output).toContain('BACKGROUND_DONE');
  });
});
