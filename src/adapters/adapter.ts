import type { LogRecord } from '../daemon/daemon-client.js';

export type AgentState =
  | 'starting'
  | 'idle'
  | 'working'
  | 'waiting-input'
  | 'waiting-permission'
  | 'error'
  | 'exited';

export type Item =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string; streaming: boolean }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; output: string; isError: boolean }
  | { kind: 'error'; message: string }
  | { kind: 'system'; text: string }
  | {
      kind: 'turn_end';
      usage?: Record<string, unknown>;
      costUsd?: number;
      durationMs?: number;
    };

/** What one daemon log record did to the transcript and the state. */
export interface Ingest {
  state?: AgentState;
  /** The vendor's error message when state is 'error'. */
  error?: string;
  /** Items to append. */
  append?: Item[];
  /** Replace the last item if it is of this kind (streaming text). */
  updateLast?: Item;
  /** The vendor conversation id, once known. */
  conversationId?: string;
}

/**
 * Turns one vendor dialect into the normalised model. Adapters are pure:
 * a record in, an Ingest out, with only per-conversation parsing state.
 * One instance per agent session.
 */
export interface AgentAdapter {
  /** Extra daemon args for a new session; `resume` is the vendor conversation id. */
  startArgs(opts: { resume?: string | null }): string[];
  /** stdin lines for a user turn. */
  turn(text: string): unknown[];
  /** stdin lines to interrupt the current turn, if supported. */
  interrupt?(): unknown[];
  ingest(record: LogRecord): Ingest;
}

export interface AdapterFactory {
  readonly profile: string;
  create(): AgentAdapter;
}
