import type { LogRecord } from '../daemon/daemon-client.js';
import type {
  AgentAdapter,
  AdapterFactory,
  Ingest,
  Item,
  ItemOp,
} from './adapter.js';

/**
 * Drives fixtures/fake-agent.mjs, a stand-in agent that emits a realistic
 * item stream for a user turn without spending tokens. Its line shapes are
 * deliberately close to Claude's so the UI sees the same kinds of items.
 */
export class FakeAdapter implements AgentAdapter {
  private streamingText = '';
  private textKey = '';
  private texts = 0;

  startArgs({ resume }: { resume?: string | null }): string[] {
    return resume ? ['--resume', resume] : [];
  }

  turn(text: string): unknown[] {
    return [{ type: 'user', text }];
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
      if (line.type === 'user')
        return {
          state: 'working',
          ops: [append({ kind: 'user', text: line.text })],
        };
      if (line.type === 'interrupt')
        return {
          ops: [append({ kind: 'system', text: 'interrupt requested' })],
        };
      return {};
    }
    switch (line.type) {
      case 'init':
        return { conversationId: line.conversationId, state: 'idle' };
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
