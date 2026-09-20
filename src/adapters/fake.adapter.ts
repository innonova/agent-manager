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
 * Drives fixtures/fake-agent.mjs, a stand-in agent that emits a realistic
 * item stream for a user turn without spending tokens. Its line shapes are
 * deliberately close to Claude's so the UI sees the same kinds of items.
 */
export class FakeAdapter implements AgentAdapter {
  private streamingText = '';
  private textKey = '';
  private texts = 0;
  private turnOpen = false;
  /** The session's spend, as a vendor's running totals: "usage N" adds N thousand tokens in, N*10 out and N cents. */
  private spend = { inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 0 };

  private pending = new Map<
    string,
    { options: PermissionOption[]; item: PermissionItem; answered?: boolean }
  >();

  startArgs({
    resume,
    permissions,
    model,
    note,
  }: {
    resume?: string | null;
    permissions?: Permissions;
    model?: string | null;
    effort?: string | null;
    note?: string | null;
  }): string[] {
    return [
      ...(resume ? ['--resume', resume] : []),
      ...(permissions === 'ask' ? ['--ask'] : []),
      ...(model ? ['--model', model] : []),
      ...(note ? ['--note', note] : []), // a "note" turn repeats it, so tests can see what was told
    ];
  }

  afterReplay(): unknown[] {
    for (const p of this.pending.values()) p.answered = false;
    return [];
  }

  snapshot(): unknown {
    return { texts: this.texts, spend: { ...this.spend } };
  }

  restore(state: unknown): void {
    const st = (state ?? {}) as {
      texts?: number;
      spend?: FakeAdapter['spend'];
    };
    this.texts = st.texts ?? this.texts;
    if (st.spend) this.spend = { ...st.spend };
    this.turnOpen = false;
    this.pending.clear();
  }

  pendingPermissions(): PermissionRequest[] {
    return [...this.pending].map(([requestId, p]) => ({
      requestId,
      options: p.options,
    }));
  }

  decide(requestId: string, optionId: string): unknown[] | null {
    const p = this.pending.get(requestId);
    if (!p || p.answered || !p.options.some((o) => o.id === optionId))
      return null;
    p.answered = true;
    return [{ type: 'permission_response', id: requestId, decision: optionId }];
  }

  turnInProgress(): boolean {
    return this.turnOpen;
  }

  turn(text: string, images: TurnImage[] = []): unknown[] {
    return [{ type: 'user', text, ...(images.length ? { images } : {}) }];
  }

  steer(text: string, images: TurnImage[] = []): unknown[] {
    return this.turn(text, images);
  }

  interrupt(): unknown[] {
    return [{ type: 'interrupt' }];
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
    if (record.s === 'in') {
      if (line.type === 'user') {
        this.turnOpen = true;
        const images = Array.isArray(line.images)
          ? (line.images as TurnImage[])
          : [];
        return {
          state: 'working',
          ops: [
            append({
              kind: 'user',
              text: line.text,
              ...(images.length ? { images } : {}),
            }),
          ],
        };
      }
      if (line.type === 'interrupt')
        return {
          ops: [append({ kind: 'system', text: 'interrupt requested' })],
        };
      if (line.type === 'permission_response') {
        const p = this.pending.get(String(line.id));
        if (!p) return {};
        this.pending.delete(String(line.id));
        return {
          state: this.pending.size
            ? 'waiting-permission'
            : this.turnOpen
              ? 'working'
              : 'idle',
          ops: [
            {
              op: 'update',
              key: `perm:${line.id}`,
              item: { ...p.item, decision: String(line.decision) },
            },
          ],
        };
      }
      return {};
    }
    switch (line.type) {
      case 'init':
        return {
          conversationId: line.conversationId,
          state: this.turnOpen ? 'working' : 'idle',
          model: typeof line.model === 'string' ? line.model : undefined,
        };
      case 'text_start':
        this.streamingText = '';
        this.textKey = `t${++this.texts}`;
        return {
          ops: [
            {
              op: 'append',
              key: this.textKey,
              item: { kind: 'text', text: '', streaming: true },
            },
          ],
        };
      case 'text_delta':
        this.streamingText += line.text;
        return {
          ops: [
            {
              op: 'update',
              key: this.textKey,
              item: { kind: 'text', text: this.streamingText, streaming: true },
            },
          ],
        };
      case 'text_end':
        return {
          ops: [
            {
              op: 'update',
              key: this.textKey,
              item: {
                kind: 'text',
                text: this.streamingText,
                streaming: false,
              },
            },
          ],
        };
      case 'permission_request': {
        const options: PermissionOption[] = [
          { id: 'allow', kind: 'allow', label: 'Allow' },
          { id: 'allow-always', kind: 'allow-always', label: 'Always allow' },
          { id: 'deny', kind: 'deny', label: 'Deny' },
        ];
        const item: PermissionItem = {
          kind: 'permission',
          requestId: String(line.id),
          tool: String(line.tool),
          title: String(line.title),
          input: line.input ?? null,
          options,
          decision: null,
        };
        this.pending.set(String(line.id), { options, item });
        return {
          state: 'waiting-permission',
          ops: [
            {
              op: 'append',
              key: `perm:${line.id}`,
              item,
            },
          ],
        };
      }
      case 'usage': {
        const n = Number(line.fiveHour ?? 0);
        this.spend = {
          inputTokens: this.spend.inputTokens + n * 1000,
          outputTokens: this.spend.outputTokens + n * 10,
          costUsd: Math.round(this.spend.costUsd * 100 + n) / 100,
          turns: this.spend.turns + 1,
        };
        return {
          usage: {
            windows: [
              {
                name: '5h',
                usedPercent: Number(line.fiveHour ?? 0),
                resetsAt: null,
              },
              {
                name: '7d',
                usedPercent: Number(line.sevenDay ?? 0),
                resetsAt: null,
              },
            ],
            status:
              Number(line.fiveHour ?? 0) >= 100
                ? 'rejected'
                : Number(line.fiveHour ?? 0) >= 80
                  ? 'warning'
                  : 'ok',
            spend: { ...this.spend },
            at: record.t,
          },
        };
      }
      case 'background':
        return { background: Number(line.count) || 0 };
      case 'thinking':
        return { ops: [append({ kind: 'thinking', text: line.text })] };
      case 'tool_use':
        return {
          ops: [
            append({
              kind: 'tool_use',
              id: line.id,
              name: line.name,
              input: line.input,
            }),
          ],
        };
      case 'tool_result':
        return {
          ops: [
            append({
              kind: 'tool_result',
              toolUseId: line.id,
              output: line.output,
              isError: Boolean(line.isError),
            }),
          ],
        };
      case 'result':
        this.turnOpen = false;
        this.pending.clear();
        return {
          state: 'idle',
          ops: [
            append({
              kind: 'turn_end',
              durationMs: line.durationMs,
              costUsd: 0,
            }),
          ],
        };
      case 'error':
        this.turnOpen = false;
        this.pending.clear();
        return {
          state: 'error',
          error: line.message,
          ops: [
            append({ kind: 'error', message: line.message }),
            append({ kind: 'turn_end' }),
          ],
        };
      default:
        return {};
    }
  }
}

const append = (item: Item): ItemOp => ({ op: 'append', item });

export const fakeAdapterFactory: AdapterFactory = {
  profile: 'fake',
  create: () => new FakeAdapter(),
};
