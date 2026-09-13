import type { LogRecord } from '../daemon/daemon-client.js';
import type {
  AgentAdapter,
  AdapterFactory,
  Ingest,
  Item,
  ItemOp,
  PermissionOption,
  PermissionRequest,
  Permissions,
} from './adapter.js';

type PermissionItem = Extract<Item, { kind: 'permission' }>;

/**
 * GitHub Copilot CLI as an Agent Client Protocol server (`copilot --acp`).
 * JSON-RPC over stdio: initialize, session/new (or session/load to resume),
 * session/prompt per turn; session/update notifications carry the
 * content. Permissions are bypassed with `--allow-all`; should a
 * `session/request_permission` still arrive, it is answered with the
 * first allow option.
 */
export class CopilotAdapter implements AgentAdapter {
  private nextId = 1;
  private sessionId: string | null = null;
  private turnOpen = false;
  /**
   * Tool calls whose completed result said the command was started in the
   * background. Copilot reports the call completed at once, then sends the
   * job's output as a status-less update after the turn, and may go on
   * talking without a new turn. ACP has no other signal for this.
   */
  private backgroundCalls = new Set<string>();
  private pending = new Map<
    number,
    'initialize' | 'session' | 'prompt' | 'cancel'
  >();
  private textKey: string | null = null;
  private text = '';
  private texts = 0;
  private thoughtKey: string | null = null;
  private thought = '';
  private cwd = '';
  private resume: string | null = null;

  startArgs({
    extraDirs = [],
    permissions = 'bypass',
    model,
    effort,
  }: {
    resume?: string | null;
    extraDirs?: string[];
    permissions?: Permissions;
    model?: string | null;
    effort?: string | null;
  } = {}): string[] {
    // Without --allow-all, Copilot asks through session/request_permission.
    return [
      ...(permissions === 'ask' ? [] : ['--allow-all']),
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--effort', effort] : []),
      ...extraDirs.flatMap((d) => ['--add-dir', d]),
    ];
  }

  /** Request kinds already in the log, and whether initialize was answered: what a replay owes. */
  private sentKinds = new Set<string>();
  private initReplied = false;

  afterReplay(opts: {
    cwd: string;
    resume?: string | null;
    permissions?: Permissions;
  }): unknown[] {
    this.cwd = opts.cwd;
    this.resume = this.resume ?? opts.resume ?? null;
    for (const p of this.permissions.values()) p.answered = false;
    if (!this.sentKinds.has('initialize')) return this.startLines(opts);
    if (this.initReplied && !this.sentKinds.has('session'))
      return [
        this.rpc(
          'session',
          this.resume
            ? { sessionId: this.resume, cwd: this.cwd, mcpServers: [] }
            : { cwd: this.cwd, mcpServers: [] },
        ),
      ];
    return [];
  }
  /** A session/load is in flight: session/update frames are history, ignored. */
  private loading = false;
  /** request_permission requests not yet answered. */
  private permissions = new Map<
    string,
    { options: PermissionOption[]; item: PermissionItem; answered?: boolean }
  >();

  pendingPermissions(): PermissionRequest[] {
    return [...this.permissions].map(([requestId, p]) => ({
      requestId,
      options: p.options,
    }));
  }

  decide(requestId: string, optionId: string): unknown[] | null {
    const p = this.permissions.get(requestId);
    if (!p || p.answered || !p.options.some((o) => o.id === optionId))
      return null;
    p.answered = true;
    return [
      {
        jsonrpc: '2.0',
        id: Number(requestId),
        result: { outcome: { outcome: 'selected', optionId } },
      },
    ];
  }

  startLines(opts: { cwd: string; resume?: string | null }): unknown[] {
    this.cwd = opts.cwd;
    this.resume = opts.resume ?? null;
    return [
      this.rpc('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      }),
    ];
  }

  turnInProgress(): boolean {
    return this.turnOpen;
  }

  turn(text: string): unknown[] {
    if (!this.sessionId) return [];
    return [
      this.rpc('prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text }],
      }),
    ];
  }

  interrupt(): unknown[] {
    if (!this.sessionId) return [];
    return [
      {
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId: this.sessionId },
      },
    ];
  }

  private rpc(
    kind: 'initialize' | 'session' | 'prompt' | 'cancel',
    params: unknown,
  ): unknown {
    const method = {
      initialize: 'initialize',
      session: this.resume ? 'session/load' : 'session/new',
      prompt: 'session/prompt',
      cancel: 'session/cancel',
    }[kind];
    const id = this.nextId++;
    this.pending.set(id, kind);
    return { jsonrpc: '2.0', id, method, params };
  }

  ingest(record: LogRecord): Ingest {
    if (record.s === 'err')
      return { ops: [append({ kind: 'system', text: record.d })] };
    let line: any;
    try {
      line = JSON.parse(record.d);
    } catch {
      return { ops: [append({ kind: 'system', text: record.d })] };
    }
    if (record.s === 'in') return this.ingestInput(line);
    if (line?.id !== undefined && line.method === undefined)
      return this.ingestReply(line);
    switch (line?.method) {
      case 'session/update':
        if (this.loading) return {}; // replayed history during session/load
        return this.ingestUpdate(line.params?.update);
      case 'session/request_permission': {
        const requestId = String(line.id);
        const tc = line.params?.toolCall ?? {};
        const options: PermissionOption[] = (line.params?.options ?? []).map(
          (o: any) => ({
            id: String(o.optionId),
            kind: String(o.kind).startsWith('allow_always')
              ? 'allow-always'
              : String(o.kind).startsWith('allow')
                ? 'allow'
                : 'deny',
            label: String(o.name ?? o.optionId),
          }),
        );
        const item: PermissionItem = {
          kind: 'permission',
          requestId,
          tool: String(tc.kind ?? 'tool'),
          title: String(tc.title ?? ''),
          input: tc.rawInput ?? null,
          options,
          decision: null,
        };
        this.permissions.set(requestId, { options, item });
        return {
          state: 'waiting-permission',
          ops: [
            ...this.endText(),
            {
              op: 'append',
              key: `perm:${requestId}`,
              item,
            },
          ],
        };
      }
      default:
        return {};
    }
  }

  private ingestInput(line: any): Ingest {
    if (typeof line?.id === 'number' && typeof line.method === 'string') {
      const kind =
        line.method === 'initialize'
          ? 'initialize'
          : line.method === 'session/new' || line.method === 'session/load'
            ? 'session'
            : line.method === 'session/prompt'
              ? 'prompt'
              : null;
      if (kind) this.pending.set(line.id, kind);
      if (kind) this.sentKinds.add(kind);
      if (line.id >= this.nextId) this.nextId = line.id + 1;
      if (line.method === 'session/load') {
        // The id we are resuming is ours to remember: the load reply need
        // not repeat it, and a fresh adapter replaying the log has no
        // `resume` to fall back on. While the load is in flight Copilot
        // replays the conversation as session/update: history we already
        // have from our own log, not new output.
        this.resume =
          String(line.params?.sessionId ?? this.resume ?? '') || null;
        this.loading = true;
      }
      if (kind === 'prompt') {
        this.turnOpen = true;
        this.endText();
        const text = (line.params?.prompt ?? [])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('');
        return { state: 'working', ops: [append({ kind: 'user', text })] };
      }
    }
    if (
      line?.id !== undefined &&
      line.method === undefined &&
      line.result?.outcome
    ) {
      // Our answer to a permission request.
      const requestId = String(line.id);
      const p = this.permissions.get(requestId);
      if (!p) return {};
      this.permissions.delete(requestId);
      return {
        state: this.permissions.size
          ? 'waiting-permission'
          : this.turnOpen
            ? 'working'
            : 'idle',
        ops: [
          {
            op: 'update',
            key: `perm:${requestId}`,
            item: {
              ...p.item,
              decision: String(line.result.outcome.optionId ?? 'deny'),
            },
          },
        ],
      };
    }
    if (line?.method === 'session/cancel')
      return { ops: [append({ kind: 'system', text: 'interrupt requested' })] };
    return {};
  }

  private ingestReply(line: any): Ingest {
    const kind = this.pending.get(line.id);
    this.pending.delete(line.id);
    if (line.error) {
      const message = String(line.error.message ?? JSON.stringify(line.error));
      if (kind === 'prompt') this.turnOpen = false;
      const ops: ItemOp[] = [
        ...this.endText(),
        append({ kind: 'error', message }),
      ];
      if (kind === 'prompt') {
        this.permissions.clear();
        ops.push(append({ kind: 'turn_end' }));
      }
      return { state: 'error', error: message, ops };
    }
    switch (kind) {
      case 'initialize':
        this.initReplied = true;
        return {
          send: [
            this.rpc(
              'session',
              this.resume
                ? { sessionId: this.resume, cwd: this.cwd, mcpServers: [] }
                : { cwd: this.cwd, mcpServers: [] },
            ),
          ],
        };
      case 'session':
        this.loading = false;
        this.sessionId = line.result?.sessionId ?? this.resume ?? null;
        return {
          conversationId: this.sessionId ?? undefined,
          state: this.turnOpen ? 'working' : 'idle',
        };
      case 'prompt': {
        this.turnOpen = false;
        this.permissions.clear(); // a request from an ended turn cannot be answered
        const usage = line.result?.usage;
        return {
          state: 'idle',
          ops: [...this.endText(), append({ kind: 'turn_end', usage })],
        };
      }
      default:
        return {};
    }
  }

  private ingestUpdate(u: any): Ingest {
    switch (u?.sessionUpdate) {
      case 'agent_message_chunk': {
        const chunk = u.content?.type === 'text' ? String(u.content.text) : '';
        if (!this.textKey) {
          this.textKey = `t${++this.texts}`;
          this.text = chunk;
          return {
            ops: [
              ...(this.turnOpen
                ? []
                : [append({ kind: 'system', text: 'continued on its own' })]),
              {
                op: 'append',
                key: this.textKey,
                item: { kind: 'text', text: this.text, streaming: true },
              },
            ],
          };
        }
        this.text += chunk;
        return {
          ops: [
            {
              op: 'update',
              key: this.textKey,
              item: { kind: 'text', text: this.text, streaming: true },
            },
          ],
        };
      }
      case 'agent_thought_chunk': {
        const chunk = u.content?.type === 'text' ? String(u.content.text) : '';
        if (!this.thoughtKey) {
          this.thoughtKey = `th${++this.texts}`;
          this.thought = chunk;
          return {
            ops: [
              {
                op: 'append',
                key: this.thoughtKey,
                item: { kind: 'thinking', text: this.thought },
              },
            ],
          };
        }
        this.thought += chunk;
        return {
          ops: [
            {
              op: 'update',
              key: this.thoughtKey,
              item: { kind: 'thinking', text: this.thought },
            },
          ],
        };
      }
      case 'config_option_update': {
        const opt = (u.configOptions ?? []).find((o: any) => o?.id === 'model');
        const value = opt?.currentValue;
        const name =
          (opt?.options ?? []).find((o: any) => o?.value === value)?.name ??
          value;
        return typeof name === 'string' ? { model: name } : {};
      }
      case 'tool_call': {
        this.thoughtKey = null;
        return {
          ops: [
            ...this.endText(),
            append({
              kind: 'tool_use',
              id: String(u.toolCallId),
              name: String(u.title ?? u.kind ?? 'tool'),
              input: u.rawInput ?? null,
            }),
          ],
        };
      }
      case 'tool_call_update': {
        const id = String(u.toolCallId);
        if (u.status === undefined && this.backgroundCalls.has(id)) {
          // The background job's output, delivered after the turn.
          this.backgroundCalls.delete(id);
          return {
            background: this.backgroundCalls.size,
            ops: [
              append({
                kind: 'tool_result',
                toolUseId: id,
                output: this.updateText(u),
                isError: false,
              }),
            ],
          };
        }
        if (u.status !== 'completed' && u.status !== 'failed') return {};
        const output = this.updateText(u);
        if (u.status === 'completed' && /started in background/i.test(output)) {
          this.backgroundCalls.add(id);
          return {
            background: this.backgroundCalls.size,
            ops: [
              append({
                kind: 'tool_result',
                toolUseId: id,
                output,
                isError: false,
              }),
            ],
          };
        }
        return {
          ops: [
            append({
              kind: 'tool_result',
              toolUseId: String(u.toolCallId),
              output,
              isError: u.status === 'failed',
            }),
          ],
        };
      }
      default:
        return {};
    }
  }

  private updateText(u: any): string {
    return Array.isArray(u.content)
      ? u.content
          .map((c: any) =>
            c.type === 'content' && c.content?.type === 'text'
              ? c.content.text
              : c.type === 'diff'
                ? `--- ${c.path}\n${c.newText ?? ''}`
                : JSON.stringify(c),
          )
          .join('\n')
      : String(u.rawOutput?.content ?? '');
  }

  /** A streamed text item ends when something else arrives. */
  private endText(): ItemOp[] {
    this.thoughtKey = null;
    if (!this.textKey) return [];
    const op: ItemOp = {
      op: 'update',
      key: this.textKey,
      item: { kind: 'text', text: this.text, streaming: false },
    };
    this.textKey = null;
    this.text = '';
    this.thoughtKey = null;
    return [op];
  }
}

const append = (item: Item): ItemOp => ({ op: 'append', item });

export const copilotAdapterFactory: AdapterFactory = {
  profile: 'copilot',
  create: () => new CopilotAdapter(),
};
