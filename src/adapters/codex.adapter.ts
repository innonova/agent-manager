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
    'initialize' | 'thread' | 'turn' | 'interrupt'
  >();
  /** Streaming agent message items by item id; a new message id starts a new text item. */
  private textKeys = new Map<string, string>();
  private texts = new Map<string, string>();

  startArgs(): string[] {
    return [];
  }

  /** Approval requests from the server not yet answered, with the decision value behind each option. */
  private approvals = new Map<
    string,
    {
      options: PermissionOption[];
      values: Map<string, unknown>;
      item: PermissionItem;
    }
  >();
  private permissionsMode: Permissions = 'bypass';

  pendingPermissions(): PermissionRequest[] {
    return [...this.approvals].map(([requestId, a]) => ({
      requestId,
      options: a.options,
    }));
  }

  decide(requestId: string, optionId: string): unknown[] | null {
    const a = this.approvals.get(requestId);
    if (!a || !a.values.has(optionId)) return null;
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
    kind: 'initialize' | 'thread' | 'turn' | 'interrupt',
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
        this.turnOpen = false;
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
        state: this.turnOpen ? 'working' : 'idle',
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
                : null;
      if (kind) this.pending.set(line.id, kind);
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
    for (const d of decisions) {
      if (typeof d === 'string') {
        const id = d === 'accept' ? 'allow' : 'deny';
        if (values.has(id)) continue;
        values.set(id, d);
        options.push({
          id,
          kind: id,
          label: id === 'allow' ? 'Allow' : 'Deny',
        });
      } else if (
        d &&
        typeof d === 'object' &&
        'acceptWithExecpolicyAmendment' in d
      ) {
        values.set('allow-always', d);
        options.push({
          id: 'allow-always',
          kind: 'allow-always',
          label: 'Always allow',
        });
      }
    }
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
      if (kind === 'turn') this.turnOpen = false;
      return {
        state: 'error',
        error: message,
        ops: [append({ kind: 'error', message })],
      };
    }
    switch (kind) {
      case 'initialize':
        return {
          send: [
            { jsonrpc: '2.0', method: 'initialized' },
            this.resume
              ? this.rpc('thread', 'thread/resume', {
                  threadId: this.resume,
                  ...this.policy(),
                })
              : this.rpc('thread', 'thread/start', this.policy()),
          ],
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
              isError: item.exitCode != null && item.exitCode !== 0,
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
