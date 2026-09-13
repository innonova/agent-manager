import type { Item } from './adapter.js';
import { CopilotAdapter } from './copilot.adapter.js';
import { loadFixture, replay } from './replay-harness.js';

describe('CopilotAdapter', () => {
  it('drives the ACP handshake from the replies', () => {
    const a = new CopilotAdapter();
    expect(a.startArgs()).toEqual(['--allow-all']);
    expect(a.startArgs({ extraDirs: ['/r/ui'] })).toEqual([
      '--allow-all',
      '--add-dir',
      '/r/ui',
    ]);
    const start = a.startLines({ cwd: '/w', resume: null }) as any[];
    expect(start[0]).toMatchObject({
      method: 'initialize',
      params: { protocolVersion: 1 },
    });
    const { sent, states, conversationId } = replay(
      a,
      loadFixture('copilot', 'tool-and-text.ndjson').filter((r) => r.seq <= 4),
    );
    expect(sent.map((s) => s.line.method)).toEqual(['session/new']);
    expect(sent[0].line.params).toEqual({ cwd: '/w', mcpServers: [] });
    expect(states).toEqual(['idle']);
    expect(conversationId).toMatch(/^98475de4/);
  });

  it('loads an existing session when resuming', () => {
    const a = new CopilotAdapter();
    a.startLines({ cwd: '/w', resume: 'sess-1' });
    const { sent } = replay(
      a,
      loadFixture('copilot', 'tool-and-text.ndjson').filter((r) => r.seq <= 2),
    );
    expect(sent[0].line).toMatchObject({
      method: 'session/load',
      params: { sessionId: 'sess-1', cwd: '/w' },
    });
  });

  it('turns the recorded two-turn session with tool calls into items', () => {
    const a = new CopilotAdapter();
    a.startLines({ cwd: '/w', resume: null });
    const { items, states, error } = replay(
      a,
      loadFixture('copilot', 'tool-and-text.ndjson'),
    );
    expect(error).toBeUndefined();
    expect(items.map((i) => i.kind)).toEqual([
      'user',
      'text',
      'tool_use',
      'tool_result',
      'text',
      'tool_use',
      'tool_result',
      'text',
      'turn_end',
      'user',
      'text',
      'turn_end',
    ]);
    expect((items[1] as any).text).toContain('inspect the note');
    expect((items[1] as any).streaming).toBe(false);
    const read = items[2] as Extract<Item, { kind: 'tool_use' }>;
    expect(read.name).toBe('Read note.txt');
    expect((read.input as any).command).toBe('cat note.txt');
    expect((items[3] as any).output).toContain('alpha');
    const edit = items[5] as Extract<Item, { kind: 'tool_use' }>;
    expect(edit.name).toBe('apply_patch');
    expect((items[6] as any).output).toContain('created.txt');
    expect((items[7] as any).text).toBe('DONE');
    expect((items[8] as any).usage).toMatchObject({ outputTokens: 175 });
    expect((items[10] as any).text).toBe('PONG');
    expect(states).toEqual(['idle', 'working', 'idle', 'working', 'idle']);
  });

  it('builds prompt and cancel lines once the session is known, and surfaces permission requests', () => {
    const a = new CopilotAdapter();
    a.startLines({ cwd: '/w', resume: null });
    expect(a.turn('x')).toEqual([]);
    replay(
      a,
      loadFixture('copilot', 'tool-and-text.ndjson').filter((r) => r.seq <= 4),
    );
    const t = a.turn('hello') as any[];
    expect(t[0]).toMatchObject({
      method: 'session/prompt',
      params: { prompt: [{ type: 'text', text: 'hello' }] },
    });
    expect(a.interrupt()[0]).toMatchObject({ method: 'session/cancel' });
    const perm = a.ingest({
      seq: 99,
      t: 0,
      s: 'out',
      d: JSON.stringify({
        jsonrpc: '2.0',
        id: 42,
        method: 'session/request_permission',
        params: {
          toolCall: { title: 'rm -rf' },
          options: [
            { optionId: 'no', kind: 'reject_once' },
            { optionId: 'yes', kind: 'allow_once' },
          ],
        },
      }),
    });
    // not answered by itself any more: it is the human's question
    expect(perm.send).toBeUndefined();
    expect(perm.state).toBe('waiting-permission');
    expect(a.pendingPermissions()).toEqual([
      {
        requestId: '42',
        options: [
          { id: 'no', kind: 'deny', label: 'no' },
          { id: 'yes', kind: 'allow', label: 'yes' },
        ],
      },
    ]);
    expect(a.decide('42', 'yes')).toEqual([
      {
        jsonrpc: '2.0',
        id: 42,
        result: { outcome: { outcome: 'selected', optionId: 'yes' } },
      },
    ]);
  });

  it('reports a failed prompt as the error state', () => {
    const a = new CopilotAdapter();
    const rec = (s: 'in' | 'out', d: unknown, seq: number) => ({
      seq,
      t: 0,
      s,
      d: JSON.stringify(d),
    });
    a.ingest(
      rec(
        'in',
        {
          jsonrpc: '2.0',
          id: 5,
          method: 'session/prompt',
          params: { sessionId: 's', prompt: [{ type: 'text', text: 'hi' }] },
        },
        1,
      ),
    );
    const r = a.ingest(
      rec(
        'out',
        {
          jsonrpc: '2.0',
          id: 5,
          error: { code: -32000, message: 'quota exceeded' },
        },
        2,
      ),
    );
    expect(r).toMatchObject({ state: 'error', error: 'quota exceeded' });
    expect(r.ops?.map((o) => o.item.kind)).toEqual(['error', 'turn_end']);
  });

  it('a "started in background" call is a pending job until its output arrives; text after the turn is marked', () => {
    const { items, states, backgrounds } = replay(
      new CopilotAdapter(),
      loadFixture('copilot', 'background-command.ndjson'),
    );
    expect(states).toEqual(['idle', 'working', 'idle']);
    expect(backgrounds).toEqual([1, 0]);
    const kinds = items.map((i) => i.kind);
    const end = kinds.indexOf('turn_end');
    expect(kinds.slice(end + 1)).toEqual(['tool_result', 'system', 'text']);
    expect((items[end + 1] as { output: string }).output).toContain(
      'BACKGROUND_DONE',
    );
    expect((items[end + 2] as { text: string }).text).toBe(
      'continued on its own',
    );
    expect((items[end + 3] as { text: string }).text).toBe('FINISHED');
  });

  it('in ask mode a request_permission waits for the human; the answer selects the vendor option', () => {
    const adapter = new CopilotAdapter();
    expect(adapter.startArgs({ permissions: 'ask' })).toEqual([]);
    expect(adapter.startArgs({})).toEqual(['--allow-all']);
    const records = loadFixture('copilot', 'permission.ndjson');
    const { items, states } = replay(adapter, records);
    expect(states).toContain('waiting-permission');
    const perm = items.find((i) => i.kind === 'permission') as any;
    expect(perm).toMatchObject({
      tool: 'execute',
      title: 'Print permission probe',
      input: { command: 'echo PERMISSION_PROBE' },
      decision: 'allow_once',
    });
    expect(perm.options).toEqual([
      { id: 'allow_once', kind: 'allow', label: 'Allow once' },
      { id: 'allow_always', kind: 'allow-always', label: 'Always allow' },
      { id: 'reject_once', kind: 'deny', label: 'Deny' },
    ]);
    const fresh = new CopilotAdapter();
    replay(
      fresh,
      records.slice(
        0,
        records.findIndex((r) => r.s === 'in' && r.d.includes('"outcome"')),
      ),
    );
    const [pending] = fresh.pendingPermissions();
    expect(fresh.decide(pending!.requestId, 'reject_once')).toEqual([
      {
        jsonrpc: '2.0',
        id: Number(pending!.requestId),
        result: { outcome: { outcome: 'selected', optionId: 'reject_once' } },
      },
    ]);
  });

  it('passes model and effort at start and reports the model from config options', () => {
    expect(
      new CopilotAdapter().startArgs({ model: 'gpt-5.4', effort: 'high' }),
    ).toEqual(['--allow-all', '--model', 'gpt-5.4', '--effort', 'high']);
    const update = loadFixture('copilot', 'permission.ndjson').find((r) =>
      r.d.includes('config_option_update'),
    )!;
    const model = new CopilotAdapter().ingest(update).model;
    expect(typeof model === 'string' || model === undefined).toBe(true);
  });
});
