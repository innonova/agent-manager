import type { LogRecord } from '../daemon/daemon-client.js';
import type { AgentAdapter, AdapterFactory, Ingest } from './adapter.js';

/**
 * Drives fixtures/fake-agent.mjs, a stand-in agent that emits a realistic
 * item stream for a user turn without spending tokens. Its line shapes are
 * deliberately close to Claude's so the UI sees the same kinds of items.
 */
export class FakeAdapter implements AgentAdapter {
  private streamingText = '';

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
      return { append: [{ kind: 'system', text: record.d }] };
    let line: any;
    try {
      line = JSON.parse(record.d);
    } catch {
      return { append: [{ kind: 'system', text: record.d }] };
    }
    if (record.s === 'in') {
      if (line.type === 'user') {
        this.streamingText = '';
        return {
          state: 'working',
          append: [{ kind: 'user', text: line.text }],
        };
      }
      return {};
    }
    switch (line.type) {
      case 'init':
        return { conversationId: line.conversationId, state: 'idle' };
      case 'text_start':
        this.streamingText = '';
        return { append: [{ kind: 'text', text: '', streaming: true }] };
      case 'text_delta':
        this.streamingText += line.text;
        return {
          updateLast: {
            kind: 'text',
            text: this.streamingText,
            streaming: true,
          },
        };
      case 'text_end':
        return {
          updateLast: {
            kind: 'text',
            text: this.streamingText,
            streaming: false,
          },
        };
      case 'thinking':
        return { append: [{ kind: 'thinking', text: line.text }] };
      case 'tool_use':
        return {
          append: [
            {
              kind: 'tool_use',
              id: line.id,
              name: line.name,
              input: line.input,
            },
          ],
        };
      case 'tool_result':
        return {
          append: [
            {
              kind: 'tool_result',
              toolUseId: line.id,
              output: line.output,
              isError: Boolean(line.isError),
            },
          ],
        };
      case 'result':
        return {
          state: 'idle',
          append: [
            { kind: 'turn_end', durationMs: line.durationMs, costUsd: 0 },
          ],
        };
      case 'error':
        return {
          state: 'error',
          error: line.message,
          append: [
            { kind: 'error', message: line.message },
            { kind: 'turn_end' },
          ],
        };
      default:
        return {};
    }
  }
}

export const fakeAdapterFactory: AdapterFactory = {
  profile: 'fake',
  create: () => new FakeAdapter(),
};
