import type { LogRecord } from '../daemon/daemon-client.js';
import type { AgentAdapter, AdapterFactory, Ingest, Item } from './adapter.js';

/**
 * Claude Code in `-p --input-format stream-json --output-format stream-json`
 * mode. Streaming deltas grow a text (or thinking) item; the full
 * `assistant` message that follows is authoritative and replaces what the
 * deltas built. Claude emits one `assistant` line per content block.
 */
export class ClaudeAdapter implements AgentAdapter {
  /** The content block in progress, built from stream deltas. */
  private streaming: {
    index: number;
    kind: 'text' | 'thinking';
    text: string;
  } | null = null;
  private turnOpen = false;

  startArgs({ resume }: { resume?: string | null }): string[] {
    const args = ['--dangerously-skip-permissions'];
    if (resume) args.push('--resume', resume);
    return args;
  }

  turn(text: string): unknown[] {
    return [{ type: 'user', message: { role: 'user', content: text } }];
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
      return { append: [{ kind: 'system', text: record.d }] };
    let line: any;
    try {
      line = JSON.parse(record.d);
    } catch {
      return { append: [{ kind: 'system', text: record.d }] };
    }
    if (record.s === 'in') return this.ingestInput(line);
    switch (line?.type) {
      case 'system':
        if (line.subtype === 'init')
          return {
            conversationId: line.session_id,
            state: this.turnOpen ? 'working' : 'idle',
          };
        return {};
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
        const message = String(line.message ?? line.error ?? record.d);
        return {
          state: 'error',
          error: message,
          append: [{ kind: 'error', message }],
        };
      }
      default:
        return {};
    }
  }

  private ingestInput(line: any): Ingest {
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
      this.turnOpen = true;
      this.streaming = null;
      return { state: 'working', append: [{ kind: 'user', text }] };
    }
    if (
      line?.type === 'control_request' &&
      line.request?.subtype === 'interrupt'
    ) {
      return { append: [{ kind: 'system', text: 'interrupt requested' }] };
    }
    return {};
  }

  private ingestStreamEvent(ev: any): Ingest {
    switch (ev?.type) {
      case 'content_block_start': {
        const block = ev.content_block;
        if (block?.type === 'text') {
          this.streaming = {
            index: ev.index,
            kind: 'text',
            text: block.text ?? '',
          };
          return {
            append: [
              { kind: 'text', text: this.streaming.text, streaming: true },
            ],
          };
        }
        if (block?.type === 'thinking') {
          // Becomes an item only once there is text; some models emit signature-only thinking.
          this.streaming = {
            index: ev.index,
            kind: 'thinking',
            text: block.thinking ?? '',
          };
        }
        return {};
      }
      case 'content_block_delta': {
        if (!this.streaming || ev.index !== this.streaming.index) return {};
        if (this.streaming.kind === 'text' && ev.delta?.type === 'text_delta') {
          this.streaming.text += ev.delta.text;
          return {
            updateLast: {
              kind: 'text',
              text: this.streaming.text,
              streaming: true,
            },
          };
        }
        if (
          this.streaming.kind === 'thinking' &&
          ev.delta?.type === 'thinking_delta' &&
          ev.delta.thinking
        ) {
          const first = this.streaming.text === '';
          this.streaming.text += ev.delta.thinking;
          const item: Item = { kind: 'thinking', text: this.streaming.text };
          return first ? { append: [item] } : { updateLast: item };
        }
        return {};
      }
      case 'content_block_stop': {
        if (this.streaming && ev.index === this.streaming.index) {
          const { kind, text } = this.streaming;
          this.streaming = null;
          if (kind === 'text')
            return { updateLast: { kind: 'text', text, streaming: false } };
        }
        return {};
      }
      default:
        return {};
    }
  }

  /** The complete block: authoritative. Replaces the streamed item of the same kind, or is appended. */
  private ingestAssistant(message: any): Ingest {
    const items: Item[] = [];
    let replace: Item | undefined;
    for (const block of message?.content ?? []) {
      switch (block.type) {
        case 'text':
          if (block.text)
            replace = { kind: 'text', text: block.text, streaming: false };
          break;
        case 'thinking':
          if (block.thinking) {
            const item: Item = { kind: 'thinking', text: block.thinking };
            if (this.streaming?.kind === 'thinking' && this.streaming.text)
              replace = item;
            else items.push(item);
          }
          break;
        case 'tool_use':
          items.push({
            kind: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          });
          break;
        default:
          break;
      }
    }
    this.streaming = null;
    return { updateLast: replace, append: items };
  }

  private ingestToolResults(line: any): Ingest {
    if (line.isReplay) return {}; // our own input, echoed back by --replay-user-messages
    const items: Item[] = [];
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
      items.push({
        kind: 'tool_result',
        toolUseId: block.tool_use_id,
        output,
        isError: Boolean(block.is_error),
      });
    }
    return { append: items };
  }

  private ingestResult(line: any): Ingest {
    this.turnOpen = false;
    this.streaming = null;
    const end: Item = {
      kind: 'turn_end',
      usage: line.usage,
      costUsd: line.total_cost_usd,
      durationMs: line.duration_ms,
    };
    if (line.is_error) {
      const message =
        typeof line.result === 'string'
          ? line.result
          : (line.subtype ?? 'error');
      return {
        state: 'error',
        error: message,
        append: [{ kind: 'error', message }, end],
        conversationId: line.session_id,
      };
    }
    return { state: 'idle', append: [end], conversationId: line.session_id };
  }
}

export const claudeAdapterFactory: AdapterFactory = {
  profile: 'claude',
  create: () => new ClaudeAdapter(),
};
