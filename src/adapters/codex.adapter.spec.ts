import type { Item } from './adapter.js';
import { CodexAdapter } from './codex.adapter.js';
import { loadFixture, replay } from './replay-harness.js';

describe('CodexAdapter', () => {
  it('steers the active turn with turn/steer, and only once the turn id is known', () => {
    const a = new CodexAdapter();
    const rec = (s: 'in' | 'out', d: unknown, seq: number) => ({
      seq,
      t: 0,
      s,
      d: JSON.stringify(d),
    });
    a.startLines({ cwd: '/w', resume: null });
    replay(a, loadFixture('codex', 'tool-and-text.ndjson')); // ends idle
    expect(a.turnInProgress()).toBe(false);
    expect(a.steer('wait')).toEqual([]); // no turn running
    const [turn] = a.turn('go') as any[];
    a.ingest(rec('in', turn, 100));
    expect(a.steer('wait')).toEqual([]); // running, but the id is not known yet
    a.ingest(
      rec(
        'out',
        {
          method: 'turn/started',
          params: { threadId: turn.params.threadId, turn: { id: 'turn-7' } },
        },
        101,
      ),
    );
    const [steer] = a.steer('also do this') as any[];
    expect(steer).toMatchObject({
      method: 'turn/steer',
      params: {
        threadId: turn.params.threadId,
        expectedTurnId: 'turn-7',
        input: [{ type: 'text', text: 'also do this' }],
      },
    });
    // logged as our input: a user item, the turn still open
    const echoed = a.ingest(rec('in', steer, 102));
    expect(echoed.ops).toEqual([
      { op: 'append', item: { kind: 'user', text: 'also do this' } },
    ]);
    expect(a.turnInProgress()).toBe(true);
    expect(
      a.ingest(
        rec(
          'out',
          { jsonrpc: '2.0', id: steer.id, result: { turnId: 'turn-7' } },
          103,
        ),
      ),
    ).toEqual({});
    // a refused steer is a note, not an error state
    const [late] = a.steer('too late') as any[];
    a.ingest(rec('in', late, 104));
    const refused = a.ingest(
      rec(
        'out',
        { jsonrpc: '2.0', id: late.id, error: { message: 'turn is over' } },
        105,
      ),
    );
    expect(refused.state).toBeUndefined();
    expect(refused.ops?.[0]?.item).toMatchObject({
      kind: 'system',
      text: /message not taken/,
    });
  });

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
    expect(sent[1].line.params).not.toHaveProperty('developerInstructions');
  });

  it('sends the harness note as developerInstructions with the thread line, started or resumed', () => {
    for (const resume of [null, 'thread-1']) {
      const a = new CodexAdapter();
      a.startLines({ cwd: '/w', resume, note: 'You run here.' });
      const { sent } = replay(
        a,
        loadFixture('codex', 'tool-and-text.ndjson').filter((r) => r.seq <= 2),
      );
      expect(sent[1].line).toMatchObject({
        method: resume ? 'thread/resume' : 'thread/start',
        params: { developerInstructions: 'You run here.' },
      });
    }
  });

  it('turns the recorded two-turn session with a command into items', () => {
    const a = new CodexAdapter();
    a.startLines({ cwd: '/w', resume: null });
    const { items, states, activities, conversationId, error } = replay(
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
    // a command's activity names it; the reply around it is `writing`
    const toolKinds = activities.filter((act) => act?.kind === 'tool');
    expect(toolKinds.map((act) => act?.detail)).toEqual([
      "/bin/bash -lc 'cat note.txt'",
      "/bin/bash -lc 'printf beta > created.txt'",
    ]);
    expect(activities.some((act) => act?.kind === 'writing')).toBe(true);
    expect(activities[0]).toEqual({ kind: 'writing' });
  });

  it('sums output tokens across thread/tokenUsage/updated while an activity is still open, stays absent until reported, and resets per turn', () => {
    const a = new CodexAdapter();
    const rec = (s: 'in' | 'out', d: unknown, seq: number) => ({
      seq,
      t: 0,
      s,
      d: JSON.stringify(d),
    });
    a.startLines({ cwd: '/w', resume: null });
    a.ingest(
      rec(
        'out',
        {
          method: 'turn/started',
          params: { threadId: 't1', turn: { id: 'turn-1' } },
        },
        1,
      ),
    );
    // a command still running when the token report arrives: it carries the count
    a.ingest(
      rec(
        'out',
        {
          method: 'item/started',
          params: {
            item: { type: 'commandExecution', id: 'c1', command: 'ls' },
          },
        },
        2,
      ),
    );
    expect(
      a.ingest(
        rec(
          'out',
          {
            method: 'thread/tokenUsage/updated',
            params: { tokenUsage: { last: { outputTokens: 10 } } },
          },
          3,
        ),
      ),
    ).toMatchObject({ activity: { kind: 'tool', tokens: 10 } });
    // the command finishes; a token report with nothing open to attach to says nothing about activity
    a.ingest(
      rec(
        'out',
        {
          method: 'item/completed',
          params: {
            item: { type: 'commandExecution', id: 'c1', status: 'completed' },
          },
        },
        4,
      ),
    );
    expect(
      a.ingest(
        rec(
          'out',
          {
            method: 'thread/tokenUsage/updated',
            params: { tokenUsage: { last: { outputTokens: 7 } } },
          },
          5,
        ),
      ).activity,
    ).toBeUndefined();
    // a second command opens after: it picks up the running total (17), not a fresh 0
    expect(
      a.ingest(
        rec(
          'out',
          {
            method: 'item/started',
            params: {
              item: { type: 'commandExecution', id: 'c2', command: 'pwd' },
            },
          },
          6,
        ),
      ),
    ).toMatchObject({ activity: { kind: 'tool', tokens: 17 } });
    // before any report this turn, tokens is absent, not a misleading 0
    const b = new CodexAdapter();
    b.startLines({ cwd: '/w', resume: null });
    b.ingest(
      rec(
        'out',
        {
          method: 'turn/started',
          params: { threadId: 't1', turn: { id: 'turn-x' } },
        },
        1,
      ),
    );
    expect(
      b.ingest(
        rec(
          'out',
          {
            method: 'item/started',
            params: { item: { type: 'reasoning', id: 'r1' } },
          },
          2,
        ),
      ).activity,
    ).toEqual({ kind: 'thinking' });
    // the turn ends and a new one starts: the count is not carried over
    a.ingest(
      rec(
        'out',
        {
          method: 'turn/completed',
          params: { turn: { id: 'turn-1', status: 'completed' } },
        },
        7,
      ),
    );
    a.ingest(
      rec(
        'out',
        {
          method: 'turn/started',
          params: { threadId: 't1', turn: { id: 'turn-2' } },
        },
        8,
      ),
    );
    const fresh = a.ingest(
      rec(
        'out',
        {
          method: 'item/started',
          params: {
            item: { type: 'commandExecution', id: 'c3', command: 'pwd' },
          },
        },
        9,
      ),
    );
    expect(fresh.activity).toMatchObject({ kind: 'tool' });
    expect(fresh.activity).not.toHaveProperty('tokens');
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

  it('in ask mode an approval request waits for the human; the decision echoes an available one, once', () => {
    const adapter = new CodexAdapter();
    adapter.startLines({ cwd: '/w', permissions: 'ask' });
    const records = loadFixture('codex', 'permission.ndjson');
    const { items, states } = replay(adapter, records);
    expect(states).toContain('waiting-permission');
    expect(states[states.length - 1]).toBe('idle');
    const perm = items.find((i) => i.kind === 'permission') as any;
    expect(perm).toMatchObject({ tool: 'command', decision: 'allow' });
    expect(perm.input.command).toContain('touch');
    expect(perm.options.map((o: any) => o.kind)).toEqual([
      'allow',
      'allow-always',
      'deny',
    ]);
    // the command ran after the approval: its result is not an error
    const result = items.find((i) => i.kind === 'tool_result') as any;
    expect(result.isError).toBe(false);

    const upTo = records.slice(
      0,
      records.findIndex((r) => r.s === 'in' && r.d.includes('"decision"')),
    );
    const pendingOn = () => {
      const fresh = new CodexAdapter();
      replay(fresh, upTo);
      return { fresh, id: fresh.pendingPermissions()[0]!.requestId };
    };
    let { fresh, id } = pendingOn();
    expect(fresh.decide(id, 'allow')).toEqual([
      { jsonrpc: '2.0', id: Number(id), result: { decision: 'accept' } },
    ]);
    expect(fresh.decide(id, 'deny')).toBeNull(); // answered once
    ({ fresh, id } = pendingOn());
    expect(
      (fresh.decide(id, 'allow-always') as any)[0].result.decision,
    ).toMatchObject({
      acceptWithExecpolicyAmendment: expect.anything(),
    });
    ({ fresh, id } = pendingOn());
    expect(fresh.decide(id, 'deny')).toEqual([
      { jsonrpc: '2.0', id: Number(id), result: { decision: 'cancel' } },
    ]);
  });

  it('maps every Codex decision explicitly: a denial never becomes an approval', () => {
    const adapter = new CodexAdapter();
    const { items } = replay(adapter, [
      {
        seq: 1,
        t: 0,
        s: 'out',
        d: JSON.stringify({
          method: 'item/commandExecution/requestApproval',
          id: 7,
          params: {
            command: 'rm -rf x',
            availableDecisions: [
              'accept',
              'acceptForSession',
              'decline',
              'cancel',
            ],
          },
        }),
      },
    ]);
    const perm = items[0] as any;
    expect(perm.options).toEqual([
      { id: 'allow', kind: 'allow', label: 'Allow' },
      {
        id: 'allow-always',
        kind: 'allow-always',
        label: 'Allow for this session',
      },
      { id: 'deny', kind: 'deny', label: 'Deny' },
    ]);
    expect(adapter.decide('7', 'deny')).toEqual([
      { jsonrpc: '2.0', id: 7, result: { decision: 'decline' } },
    ]);
  });

  it('a retrying error keeps the turn open', () => {
    const adapter = new CodexAdapter();
    const { states, items } = replay(adapter, [
      {
        seq: 1,
        t: 0,
        s: 'in',
        d: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'turn/start',
          params: { threadId: 't', input: [{ type: 'text', text: 'go' }] },
        }),
      },
      {
        seq: 2,
        t: 0,
        s: 'out',
        d: JSON.stringify({
          method: 'error',
          params: { error: { message: 'rate limited' }, willRetry: true },
        }),
      },
    ]);
    expect(states).toEqual(['working']);
    expect(items.map((i) => i.kind)).toEqual(['user', 'system']);
    expect(adapter.turnInProgress()).toBe(true);
  });

  it('ask mode starts the thread with on-request approvals in the workspace sandbox', () => {
    const adapter = new CodexAdapter();
    adapter.startLines({ cwd: '/w', permissions: 'ask' });
    const { sent } = replay(adapter, [
      {
        seq: 1,
        t: 0,
        s: 'out',
        d: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
      },
    ]);
    const start = sent.find((x) => x.line.method === 'thread/start');
    expect(start?.line.params).toEqual({
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    });
  });

  it('passes model and effort as config overrides and reports the model from thread/started', () => {
    expect(
      new CodexAdapter().startArgs({ model: 'gpt-6', effort: 'high' }),
    ).toEqual(['-c', 'model="gpt-6"', '-c', 'model_reasoning_effort="high"']);
    const started = loadFixture('codex', 'permission.ndjson').find((r) =>
      r.d.includes('"method":"thread/started"'),
    )!;
    expect(new CodexAdapter().ingest(started).model).toBe('gpt-6-astra');
  });
});
