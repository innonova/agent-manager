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

/**
 * A transcript operation. `append` adds an item, optionally under a key so
 * that later `update`s can find it; `update` replaces the item with that
 * key, or appends it if the key is unknown. Keys are per session.
 */
export type ItemOp =
  | { op: 'append'; item: Item; key?: string }
  | { op: 'update'; key: string; item: Item };

/** What one daemon log record did to the transcript and the state. */
export interface Ingest {
  state?: AgentState;
  /** The vendor's error message when state is 'error'. */
  error?: string;
  ops?: ItemOp[];
  /** The vendor conversation id, once known. */
  conversationId?: string;
}

/**
 * Turns one vendor dialect into the normalised model. Adapters are pure:
 * a record in, an Ingest out, with only per-session parsing state. One
 * instance per daemon session.
 */
export interface AgentAdapter {
  /** State right after the process starts, before it has said anything. Default 'starting'. */
  readonly initialState?: AgentState;
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
