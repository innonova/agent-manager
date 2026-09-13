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
 * Codex in `codex app-server` mode: JSON-RPC over stdio. The adapter drives
 * the handshake from the replies (initialize, initialized, thread/start or
 * thread/resume) and only reports idle once a thread exists. Approvals are
 * off and the sandbox is open, per the permissions decision.
 */
export class CodexAdapter implements AgentAdapter {
  private nextId = 1;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private turnOpen = false;
  /**
   * Commands started and not yet completed. Codex runs a command the model
   * backgrounds past the end of the turn and completes its item later,
   * without starting a new turn; those are the agent's background jobs.
   */
  private openCommands = new Set<string>();
  /** JSON-RPC ids we sent and what they were for. */
  private pending = new Map<
    number,
    'initialize' | 'thread' | 'turn' | 'interrupt' | 'steer'
  >();
  /** Streaming agent message items by item id; a new message id starts a new text item. */
  private textKeys = new Map<string, string>();
  private texts = new Map<string, string>();

  startArgs({
    model,
    effort,
  }: { model?: string | null; effort?: string | null } = {}): string[] {
    // app-server takes config overrides on its command line
    const args: string[] = [];
    if (model) args.push('-c', `model=${JSON.stringify(model)}`);
    if (effort)
      args.push('-c', `model_reasoning_effort=${JSON.stringify(effort)}`);
    return args;
  }

  /** Approval requests from the server not yet answered, with the decision value behind each option. */
  private approvals = new Map<
    string,
    {
      options: PermissionOption[];
      values: Map<string, unknown>;
      item: PermissionItem;
      answered?: boolean;
    }
  >();
  private permissionsMode: Permissions = 'bypass';
  /** Request kinds already in the log, and whether initialize was answered: what a replay owes. */
  private sentKinds = new Set<string>();
  private initReplied = false;
  private cwd = '';

  afterReplay(opts: {
    cwd: string;
    resume?: string | null;
    permissions?: Permissions;
  }): unknown[] {
    this.permissionsMode = opts.permissions ?? this.permissionsMode;
    this.resume = opts.resume ?? this.resume;
    // a reservation whose answer never reached the log is released
    for (const a of this.approvals.values()) a.answered = false;
    if (!this.sentKinds.has('initialize')) return this.startLines(opts);
    if (this.initReplied && !this.sentKinds.has('thread'))
      return [{ jsonrpc: '2.0', method: 'initialized' }, this.threadLine()];
    return [];
  }

  private threadLine(): unknown {
    return this.resume
      ? this.rpc('thread', 'thread/resume', {
          threadId: this.resume,
          ...this.policy(),
        })
      : this.rpc('thread', 'thread/start', this.policy());
  }

  snapshot(): unknown {
    return {
      threadId: this.threadId,
      resume: this.resume,
      nextId: this.nextId,
      pending: [...this.pending],
      sentKinds: [...this.sentKinds],
      initReplied: this.initReplied,
      permissionsMode: this.permissionsMode,
      openCommands: [...this.openCommands],
    };
  }

  restore(state: unknown): void {
    const st = (state ?? {}) as Partial<{
      threadId: string | null;
      resume: string | null;
      nextId: number;
      pending: [
        number,
        'initialize' | 'thread' | 'turn' | 'interrupt' | 'steer',
      ][];
      sentKinds: string[];
      initReplied: boolean;
      permissionsMode: Permissions;
      openCommands: string[];
    }>;
    this.threadId = st.threadId ?? null;
    this.resume = st.resume ?? null;
    this.nextId = st.nextId ?? this.nextId;
    this.pending = new Map(st.pending ?? []);
    this.sentKinds = new Set(st.sentKinds ?? []);
    this.initReplied = st.initReplied ?? false;
    this.permissionsMode = st.permissionsMode ?? 'bypass';
    this.openCommands = new Set(st.openCommands ?? []);
    this.turnOpen = false;
    this.turnId = null;
    this.approvals.clear();
    this.textKeys.clear();
    this.texts.clear();
  }

  pendingPermissions(): PermissionRequest[] {
    return [...this.approvals].map(([requestId, a]) => ({
      requestId,
      options: a.options,
    }));
  }

  decide(requestId: string, optionId: string): unknown[] | null {
    const a = this.approvals.get(requestId);
    if (!a || a.answered || !a.values.has(optionId)) return null;
    a.answered = true;
    return [
      {
        jsonrpc: '2.0',
        id: Number(requestId),
        result: { decision: a.values.get(optionId) },
      },
    ];
  }

  startLines(opts: {
    cwd: string;
    resume?: string | null;
    permissions?: Permissions;
  }): unknown[] {
    this.resume = opts.resume ?? null;
    this.permissionsMode = opts.permissions ?? 'bypass';
    return [
      this.rpc('initialize', 'initialize', {
        clientInfo: {
          name: 'agent-manager',
          title: 'agent-manager',
          version: '0.0.1',
        },
      }),
    ];
  }

  turnInProgress(): boolean {
    return this.turnOpen;
  }

  turn(text: string): unknown[] {
    if (!this.threadId) return [];
    return [
      this.rpc('turn', 'turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text }],
      }),
    ];
  }

  /** `turn/steer`: input the model sees at its next step of the active turn; nothing before the turn id is known. */
  steer(text: string): unknown[] {
    if (!this.threadId || !this.turnId) return [];
    return [
      this.rpc('steer', 'turn/steer', {
        threadId: this.threadId,
        expectedTurnId: this.turnId,
        input: [{ type: 'text', text }],
      }),
    ];
  }

  interrupt(): unknown[] {
    if (!this.threadId || !this.turnId) return [];
    return [
      this.rpc('interrupt', 'turn/interrupt', {
        threadId: this.threadId,
        turnId: this.turnId,
      }),
    ];
  }

  private resume: string | null = null;

  private rpc(
    kind: 'initialize' | 'thread' | 'turn' | 'interrupt' | 'steer',
    method: string,
    params: unknown,
  ): unknown {
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
    if (
      line?.id !== undefined &&
      (line.result !== undefined || line.error !== undefined)
    )
      return this.ingestReply(line);
    if (
      typeof line?.method === 'string' &&
      line.id !== undefined &&
      line.method.endsWith('/requestApproval')
    )
      return this.ingestApproval(line);
    switch (line?.method) {
      case 'thread/started': {
        const model = line.params?.thread?.model;
        return typeof model === 'string' ? { model } : {};
      }
      case 'turn/started':
        this.turnId = line.params?.turn?.id ?? null;
        this.turnOpen = true;
        return { state: 'working' };
      case 'item/started':
        return this.ingestItem(line.params?.item, false);
      case 'item/completed': {
        const ing = this.ingestItem(line.params?.item, true);
        // A command completing after the turn ended was a background job.
        if (line.params?.item?.type === 'commandExecution' && !this.turnOpen)
          ing.background = this.openCommands.size;
        return ing;
      }
      case 'item/agentMessage/delta': {
        const id = String(line.params?.itemId);
        const key = this.textKeys.get(id);
        if (!key) return {};
        const text =
          (this.texts.get(id) ?? '') + String(line.params?.delta ?? '');
        this.texts.set(id, text);
        return {
          ops: [
            {
              op: 'update',
              key,
              item: { kind: 'text', text, streaming: true },
            },
          ],
        };
      }
      case 'turn/completed': {
        this.turnOpen = false;
        this.turnId = null;
        this.approvals.clear(); // a request from an ended turn cannot be answered
        const turn = line.params?.turn;
        const end: Item = {
          kind: 'turn_end',
          durationMs: turn?.durationMs ?? undefined,
        };
        if (turn?.status === 'failed' || turn?.error) {
          const message = String(
            turn?.error?.message ?? turn?.error ?? 'turn failed',
          );
          return {
            state: 'error',
            error: message,
            ops: [append({ kind: 'error', message }), append(end)],
          };
        }
        return {
          state: 'idle',
          background: this.openCommands.size,
          ops: [append(end)],
        };
      }
      case 'error': {
        const message = String(
          line.params?.error?.message ?? line.params?.message ?? record.d,
        );
        // A retrying error is a diagnostic, not the end of the turn.
        if (line.params?.willRetry === true)
          return {
            ops: [append({ kind: 'system', text: `retrying: ${message}` })],
          };
        this.turnOpen = false;
        this.approvals.clear();
        return {
          state: 'error',
          error: message,
          ops: [append({ kind: 'error', message })],
        };
      }
      default:
        return {};
    }
  }

  private ingestInput(line: any): Ingest {
    if (line?.id !== undefined && line.method === undefined && line.result) {
      // Our answer to an approval request.
      const requestId = String(line.id);
      const a = this.approvals.get(requestId);
      if (!a) return {};
      this.approvals.delete(requestId);
      const chosen = JSON.stringify(line.result.decision);
      const decision =
        [...a.values].find(([, v]) => JSON.stringify(v) === chosen)?.[0] ??
        'deny';
      return {
        state: this.approvals.size
          ? 'waiting-permission'
          : this.turnOpen
            ? 'working'
            : 'idle',
        ops: [
          {
            op: 'update',
            key: `perm:${requestId}`,
            item: { ...a.item, decision: decision },
          },
        ],
      };
    }
    // Our own requests, as logged by the daemon: keep the id map consistent after a restart.
    if (typeof line?.id === 'number' && typeof line.method === 'string') {
      const kind =
        line.method === 'initialize'
          ? 'initialize'
          : line.method === 'thread/start' || line.method === 'thread/resume'
            ? 'thread'
            : line.method === 'turn/start'
              ? 'turn'
              : line.method === 'turn/interrupt'
                ? 'interrupt'
                : line.method === 'turn/steer'
                  ? 'steer'
                  : null;
      if (kind) this.pending.set(line.id, kind);
      if (kind) this.sentKinds.add(kind);
      if (line.method === 'thread/resume' && line.params?.threadId)
        this.resume = String(line.params.threadId);
      if (line.id >= this.nextId) this.nextId = line.id + 1;
      if (kind === 'turn') {
        this.turnOpen = true;
        const text = (line.params?.input ?? [])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('');
        return { state: 'working', ops: [append({ kind: 'user', text })] };
      }
      if (kind === 'interrupt')
        return {
          ops: [append({ kind: 'system', text: 'interrupt requested' })],
        };
      if (kind === 'steer') {
        const text = (line.params?.input ?? [])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('');
        return { ops: [append({ kind: 'user', text })] };
      }
    }
    return {};
  }

  /** Ask mode keeps Codex in its workspace sandbox and lets it ask to escalate; bypass opens everything. */
  private policy(): { approvalPolicy: string; sandbox: string } {
    return this.permissionsMode === 'ask'
      ? { approvalPolicy: 'on-request', sandbox: 'workspace-write' }
      : { approvalPolicy: 'never', sandbox: 'danger-full-access' };
  }

  /**
   * A server request for approval (`item/commandExecution/requestApproval`,
   * `item/fileChange/requestApproval`, …): the turn waits until we reply
   * with one of `availableDecisions`. Those are strings ("accept",
   * "cancel") or objects (accept with an exec-policy amendment, i.e. always
   * allow this command); the object is echoed back verbatim.
   */
  private ingestApproval(line: any): Ingest {
    const requestId = String(line.id);
    const p = line.params ?? {};
    const values = new Map<string, unknown>();
    const options: PermissionOption[] = [];
    const decisions: unknown[] = Array.isArray(p.availableDecisions)
      ? p.availableDecisions
      : ['accept', 'cancel'];
    // Codex's decisions, mapped one by one; anything unknown is left out
    // rather than guessed, and a denial never becomes an approval.
    const STRING_DECISIONS: Record<
      string,
      { id: string; kind: PermissionOption['kind']; label: string }
    > = {
      accept: { id: 'allow', kind: 'allow', label: 'Allow' },
      acceptForSession: {
        id: 'allow-always',
        kind: 'allow-always',
        label: 'Allow for this session',
      },
      decline: { id: 'deny', kind: 'deny', label: 'Deny' },
      cancel: { id: 'deny', kind: 'deny', label: 'Deny' },
    };
    for (const d of decisions) {
      if (typeof d === 'string') {
        const o = Object.hasOwn(STRING_DECISIONS, d)
          ? STRING_DECISIONS[d]
          : undefined;
        if (!o || values.has(o.id)) continue;
        values.set(o.id, d);
        options.push({ id: o.id, kind: o.kind, label: o.label });
      } else if (
        d &&
        typeof d === 'object' &&
        'acceptWithExecpolicyAmendment' in d &&
        !values.has('allow-always')
      ) {
        values.set('allow-always', d);
        options.push({
          id: 'allow-always',
          kind: 'allow-always',
          label: 'Always allow',
        });
      }
    }
    // deny last, allow first, whatever order Codex listed them in
    options.sort(
      (a, b) =>
        ['allow', 'allow-always', 'deny'].indexOf(a.kind) -
        ['allow', 'allow-always', 'deny'].indexOf(b.kind),
    );
    const command =
      p.command ??
      (Array.isArray(p.commandActions)
        ? p.commandActions.map((a: any) => a.command).join(' && ')
        : undefined);
    const item: PermissionItem = {
      kind: 'permission',
      requestId,
      tool: String(p.kind ?? 'command'),
      title: String(p.reason ?? command ?? 'approval'),
      input: command ? { command, cwd: p.cwd } : p,
      options,
      decision: null,
    };
    this.approvals.set(requestId, { options, values, item });
    return {
      state: 'waiting-permission',
      ops: [
        {
          op: 'append',
          key: `perm:${requestId}`,
          item,
        },
      ],
    };
  }

  private ingestReply(line: any): Ingest {
    const kind = this.pending.get(line.id);
    this.pending.delete(line.id);
    if (line.error) {
      const message = String(line.error.message ?? JSON.stringify(line.error));
      if (kind === 'interrupt')
        // the turn is still running; only the interrupt was refused
        return {
          ops: [
            append({ kind: 'system', text: `interrupt refused: ${message}` }),
          ],
        };
      if (kind === 'steer')
        // the turn had moved on (or ended) before the message landed
        return {
          ops: [
            append({ kind: 'system', text: `message not taken: ${message}` }),
          ],
        };
      if (kind === 'turn') {
        this.turnOpen = false;
        this.approvals.clear();
      }
      return {
        state: 'error',
        error: message,
        ops: [append({ kind: 'error', message })],
      };
    }
    switch (kind) {
      case 'steer':
        return {};
      case 'initialize':
        this.initReplied = true;
        return {
          send: [{ jsonrpc: '2.0', method: 'initialized' }, this.threadLine()],
        };
      case 'thread': {
        this.threadId = line.result?.thread?.id ?? this.resume ?? null;
        return {
          conversationId: this.threadId ?? undefined,
          state: this.turnOpen ? 'working' : 'idle',
        };
      }
      default:
        return {};
    }
  }

  private ingestItem(item: any, completed: boolean): Ingest {
    if (!item) return {};
    switch (item.type) {
      case 'agentMessage': {
        const id = String(item.id);
        if (!completed) {
          const key = `msg${this.textKeys.size + 1}`;
          this.textKeys.set(id, key);
          this.texts.set(id, item.text ?? '');
          return {
            ops: [
              {
                op: 'append',
                key,
                item: { kind: 'text', text: item.text ?? '', streaming: true },
              },
            ],
          };
        }
        const key = this.textKeys.get(id);
        const text = String(item.text ?? this.texts.get(id) ?? '');
        this.texts.delete(id);
        this.textKeys.delete(id);
        return key
          ? {
              ops: [
                {
                  op: 'update',
                  key,
                  item: { kind: 'text', text, streaming: false },
                },
              ],
            }
          : { ops: [append({ kind: 'text', text, streaming: false })] };
      }
      case 'reasoning':
        return completed && item.text
          ? { ops: [append({ kind: 'thinking', text: String(item.text) })] }
          : {};
      case 'commandExecution':
        if (completed) this.openCommands.delete(String(item.id));
        else this.openCommands.add(String(item.id));
        if (!completed)
          return {
            ops: [
              append({
                kind: 'tool_use',
                id: String(item.id),
                name: 'shell',
                input: { command: item.command, cwd: item.cwd },
              }),
            ],
          };
        return {
          ops: [
            append({
              kind: 'tool_result',
              toolUseId: String(item.id),
              output: `${item.aggregatedOutput ?? ''}${item.exitCode != null ? `\n[exit code ${item.exitCode}]` : ''}`,
              isError:
                item.status === 'failed' ||
                (item.exitCode != null && item.exitCode !== 0),
            }),
          ],
        };
      case 'fileChange':
        if (!completed)
          return {
            ops: [
              append({
                kind: 'tool_use',
                id: String(item.id),
                name: 'edit',
                input: { changes: item.changes ?? item },
              }),
            ],
          };
        return {
          ops: [
            append({
              kind: 'tool_result',
              toolUseId: String(item.id),
              output: String(item.status ?? 'completed'),
              isError: item.status === 'failed',
            }),
          ],
        };
      default:
        return {};
    }
  }
}

const append = (item: Item): ItemOp => ({ op: 'append', item });

export const codexAdapterFactory: AdapterFactory = {
  profile: 'codex',
  create: () => new CodexAdapter(),
};
