import type { LogRecord } from '../daemon/daemon-client.js';
import type {
  AgentAdapter,
  TurnImage,
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
 * Claude Code in `-p --input-format stream-json --output-format stream-json`
 * mode. Streaming deltas grow a text (or thinking) item under a key made of
 * the message and block index; the full `assistant` line that follows is
 * authoritative and replaces it. Without partial messages there are no
 * keys and every block is simply appended in order. Claude emits one
 * `assistant` line per content block.
 */
export class ClaudeAdapter implements AgentAdapter {
  /** A process is ready as soon as it runs; Claude says nothing until the first turn. */
  readonly initialState = 'idle' as const;
  private message = 0;
  /** The content block in progress, built from stream deltas. */
  private streaming: {
    key: string;
    index: number;
    kind: 'text' | 'thinking';
    text: string;
  } | null = null;
  private turnOpen = false;

  startArgs({
    resume,
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
  }): string[] {
    // Ask mode: gated tools produce a control_request on stdout that we
    // answer on stdin; without the flag Claude just denies them.
    const args =
      permissions === 'ask'
        ? ['--permission-prompt-tool', 'stdio']
        : ['--dangerously-skip-permissions'];
    if (resume) args.push('--resume', resume);
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    for (const d of extraDirs) args.push('--add-dir', d); // the project's other repositories
    return args;
  }

  /** Ids of tasks reported as backgrounded, so their completion notices can be told apart from foreground ones. */
  private backgrounded = new Set<string>();
  /** can_use_tool requests not yet answered, with the input to echo back on allow. */
  private permissions = new Map<
    string,
    {
      input: unknown;
      options: PermissionOption[];
      item: PermissionItem;
      answered?: boolean;
    }
  >();

  afterReplay(): unknown[] {
    for (const p of this.permissions.values()) p.answered = false;
    return [];
  }

  snapshot(): unknown {
    return { backgrounded: [...this.backgrounded] };
  }

  restore(state: unknown): void {
    const st = (state ?? {}) as { backgrounded?: string[] };
    this.backgrounded = new Set(st.backgrounded ?? []);
    this.turnOpen = false;
    this.streaming = null;
    this.permissions.clear();
  }

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
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response:
            optionId === 'allow'
              ? { behavior: 'allow', updatedInput: p.input }
              : { behavior: 'deny', message: 'The user denied this.' },
        },
      },
    ];
  }

  turnInProgress(): boolean {
    return this.turnOpen;
  }

  turn(text: string, images: TurnImage[] = []): unknown[] {
    const content = images.length
      ? [
          { type: 'text', text },
          ...images.map((i) => ({
            type: 'image',
            source: { type: 'base64', media_type: i.mediaType, data: i.data },
          })),
        ]
      : text;
    return [{ type: 'user', message: { role: 'user', content } }];
  }

  /** Claude Code takes a user message during a turn and reads it after the running tool. */
  steer(text: string, images: TurnImage[] = []): unknown[] {
    return this.turn(text, images);
  }

  interrupt(): unknown[] {
    return [
      {
        type: 'control_request',
        request_id: `interrupt-${Date.now()}`,
        request: { subtype: 'interrupt' },
      },
    ];
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
    switch (line?.type) {
      case 'rate_limit_event':
        return this.ingestRateLimit(line);
      case 'system':
        return this.ingestSystem(line);
      case 'control_request':
        return this.ingestControlRequest(line);
      case 'stream_event':
        return this.ingestStreamEvent(line.event);
      case 'assistant':
        return this.ingestAssistant(line.message);
      case 'user':
        return this.ingestToolResults(line);
      case 'result':
        return this.ingestResult(line);
      case 'error': {
        this.turnOpen = false;
        this.permissions.clear();
        const message = String(line.message ?? line.error ?? record.d);
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

  /**
   * `init` opens every turn. One that arrives while no turn is open was
   * not sent by us: Claude Code starts a turn by itself when a background
   * job finishes or a scheduled wake-up fires. Background jobs are
   * announced as a full list on every change, and their start and end
   * become transcript items so the user can see what is pending.
   */
  private ingestSystem(line: any): Ingest {
    switch (line.subtype) {
      case 'init': {
        const model = typeof line.model === 'string' ? line.model : undefined;
        if (this.turnOpen)
          return { conversationId: line.session_id, state: 'working', model };
        this.turnOpen = true;
        this.streaming = null;
        return {
          conversationId: line.session_id,
          state: 'working',
          model,
          ops: [append({ kind: 'system', text: 'resumed on its own' })],
        };
      }
      case 'background_tasks_changed':
        return {
          background: Array.isArray(line.tasks) ? line.tasks.length : 0,
        };
      case 'task_started':
        if (!line.is_backgrounded) return {};
        this.backgrounded.add(String(line.task_id));
        return {
          ops: [
            append({
              kind: 'system',
              text: `background task started: ${line.description ?? line.task_id}`,
            }),
          ],
        };
      case 'task_notification': {
        if (!this.backgrounded.delete(String(line.task_id))) return {};
        return {
          ops: [
            append({
              kind: 'system',
              text: `background task ${line.status ?? 'finished'}: ${line.summary ?? line.task_id}`,
            }),
          ],
        };
      }
      default:
        return {};
    }
  }

  /** A gated tool: Claude stops until we answer. Only can_use_tool is a question for the human. */
  private ingestControlRequest(line: any): Ingest {
    const req = line.request;
    if (req?.subtype !== 'can_use_tool') return {};
    const requestId = String(line.request_id);
    const options: PermissionOption[] = [
      { id: 'allow', kind: 'allow', label: 'Allow' },
      { id: 'deny', kind: 'deny', label: 'Deny' },
    ];
    const item: PermissionItem = {
      kind: 'permission',
      requestId,
      tool: String(req.tool_name ?? 'tool'),
      title: String(req.description ?? req.display_name ?? req.tool_name ?? ''),
      input: req.input ?? null,
      options,
      decision: null,
    };
    this.permissions.set(requestId, { input: req.input, options, item });
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

  /** `rate_limit_event`: the account's rolling windows and the vendor's verdict. */
  private ingestRateLimit(line: any): Ingest {
    const info = line.rate_limit_info ?? {};
    const windows = Object.entries(
      (info.unifiedWindows ?? {}) as Record<
        string,
        { utilization?: number; resetsAt?: number }
      >,
    )
      .filter(([k]) => k === 'five_hour' || k === 'seven_day')
      .map(([k, w]) => ({
        name: k === 'five_hour' ? '5h' : '7d',
        usedPercent: Math.round(Number(w.utilization ?? 0) * 100),
        resetsAt: w.resetsAt ? Number(w.resetsAt) * 1000 : null,
      }));
    const status =
      info.status === 'rejected'
        ? ('rejected' as const)
        : info.status === 'allowed_warning'
          ? ('warning' as const)
          : ('ok' as const);
    return windows.length ? { usage: { windows, status, at: Date.now() } } : {};
  }

  private ingestInput(line: any): Ingest {
    if (line?.type === 'control_response') {
      const requestId = String(line.response?.request_id);
      const p = this.permissions.get(requestId);
      if (!p) return {};
      this.permissions.delete(requestId);
      const decision =
        line.response?.response?.behavior === 'allow' ? 'allow' : 'deny';
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
            item: { ...p.item, decision: decision },
          },
        ],
      };
    }
    if (line?.type === 'user') {
      const c = line.message?.content;
      const text =
        typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? c
                .filter((b: any) => b.type === 'text')
                .map((b: any) => b.text)
                .join('')
            : '';
      const images = Array.isArray(c)
        ? c
            .filter(
              (b: any) => b.type === 'image' && b.source?.type === 'base64',
            )
            .map((b: any) => ({
              mediaType: String(b.source.media_type),
              data: String(b.source.data),
            }))
        : [];
      const item = {
        kind: 'user' as const,
        text,
        ...(images.length ? { images } : {}),
      };
      if (this.turnOpen) {
        // A message steered into the running turn: the stream under way
        // and any pending permission are untouched by it.
        return {
          state: this.permissions.size ? 'waiting-permission' : 'working',
          ops: [append(item)],
        };
      }
      this.turnOpen = true;
      this.streaming = null;
      return { state: 'working', ops: [append(item)] };
    }
    if (
      line?.type === 'control_request' &&
      line.request?.subtype === 'interrupt'
    ) {
      return { ops: [append({ kind: 'system', text: 'interrupt requested' })] };
    }
    return {};
  }

  private ingestStreamEvent(ev: any): Ingest {
    switch (ev?.type) {
      case 'message_start':
        this.message++;
        return {};
      case 'content_block_start': {
        const block = ev.content_block;
        const key = `m${this.message}b${ev.index}`;
        if (block?.type === 'text') {
          this.streaming = {
            key,
            index: ev.index,
            kind: 'text',
            text: block.text ?? '',
          };
          return {
            ops: [
              {
                op: 'append',
                key,
                item: {
                  kind: 'text',
                  text: this.streaming.text,
                  streaming: true,
                },
              },
            ],
          };
        }
        if (block?.type === 'thinking') {
          // Becomes an item only once there is text; some models emit signature-only thinking.
          this.streaming = {
            key,
            index: ev.index,
            kind: 'thinking',
            text: block.thinking ?? '',
          };
        }
        return {};
      }
      case 'content_block_delta': {
        const s = this.streaming;
        if (!s || ev.index !== s.index) return {};
        if (s.kind === 'text' && ev.delta?.type === 'text_delta') {
          s.text += ev.delta.text;
          return {
            ops: [
              {
                op: 'update',
                key: s.key,
                item: { kind: 'text', text: s.text, streaming: true },
              },
            ],
          };
        }
        if (
          s.kind === 'thinking' &&
          ev.delta?.type === 'thinking_delta' &&
          ev.delta.thinking
        ) {
          s.text += ev.delta.thinking;
          return {
            ops: [
              {
                op: 'update',
                key: s.key,
                item: { kind: 'thinking', text: s.text },
              },
            ],
          };
        }
        return {};
      }
      case 'content_block_stop': {
        const s = this.streaming;
        if (s && ev.index === s.index) {
          this.streaming = null;
          if (s.kind === 'text')
            return {
              ops: [
                {
                  op: 'update',
                  key: s.key,
                  item: { kind: 'text', text: s.text, streaming: false },
                },
              ],
            };
        }
        return {};
      }
      default:
        return {};
    }
  }

  /** The complete block: authoritative. Replaces the streamed item under its key, or is appended. */
  private ingestAssistant(message: any): Ingest {
    const ops: ItemOp[] = [];
    const s = this.streaming;
    for (const block of message?.content ?? []) {
      switch (block.type) {
        case 'text':
          if (!block.text) break;
          if (s?.kind === 'text')
            ops.push({
              op: 'update',
              key: s.key,
              item: { kind: 'text', text: block.text, streaming: false },
            });
          else
            ops.push(
              append({ kind: 'text', text: block.text, streaming: false }),
            );
          break;
        case 'thinking':
          if (!block.thinking) break;
          if (s?.kind === 'thinking' && s.text)
            ops.push({
              op: 'update',
              key: s.key,
              item: { kind: 'thinking', text: block.thinking },
            });
          else ops.push(append({ kind: 'thinking', text: block.thinking }));
          break;
        case 'tool_use':
          ops.push(
            append({
              kind: 'tool_use',
              id: block.id,
              name: block.name,
              input: block.input,
            }),
          );
          break;
        default:
          break;
      }
    }
    this.streaming = null;
    return { ops };
  }

  private ingestToolResults(line: any): Ingest {
    if (line.isReplay) return {}; // our own input, echoed back by --replay-user-messages
    const ops: ItemOp[] = [];
    for (const block of Array.isArray(line.message?.content)
      ? line.message.content
      : []) {
      if (block.type !== 'tool_result') continue;
      const output =
        typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content
                .map((c: any) =>
                  c.type === 'text' ? c.text : JSON.stringify(c),
                )
                .join('\n')
            : '';
      ops.push(
        append({
          kind: 'tool_result',
          toolUseId: block.tool_use_id,
          output,
          isError: Boolean(block.is_error),
        }),
      );
    }
    return { ops };
  }

  private ingestResult(line: any): Ingest {
    this.turnOpen = false;
    this.streaming = null;
    this.permissions.clear(); // a request from an ended turn cannot be answered
    const end: Item = {
      kind: 'turn_end',
      usage: line.usage,
      costUsd: line.total_cost_usd,
      durationMs: line.duration_ms,
    };
    if (line.is_error) {
      // The documented error shape carries `errors: string[]`; `result` and the subtype are fallbacks.
      const message =
        Array.isArray(line.errors) && line.errors.length
          ? line.errors.map(String).join('\n')
          : typeof line.result === 'string' && line.result
            ? line.result
            : String(line.subtype ?? 'error');
      return {
        state: 'error',
        error: message,
        ops: [append({ kind: 'error', message }), append(end)],
        conversationId: line.session_id,
      };
    }
    return {
      state: 'idle',
      ops: [append(end)],
      conversationId: line.session_id,
    };
  }
}

const append = (item: Item): ItemOp => ({ op: 'append', item });

export const claudeAdapterFactory: AdapterFactory = {
  profile: 'claude',
  create: () => new ClaudeAdapter(),
};
