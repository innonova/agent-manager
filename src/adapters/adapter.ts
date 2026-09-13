import type { LogRecord } from '../daemon/daemon-client.js';

export type AgentState =
  | 'starting'
  | 'idle'
  | 'working'
  | 'waiting-input'
  | 'waiting-permission'
  | 'error'
  | 'exited';

/** Whether the agent may act without asking, or must ask the human before gated tools. */
export type Permissions = 'bypass' | 'ask';

export interface PermissionOption {
  /** The vendor's own id for the choice; sent back as is. */
  id: string;
  kind: 'allow' | 'allow-always' | 'deny';
  label: string;
}

export interface PermissionRequest {
  requestId: string;
  options: PermissionOption[];
}

export type Item =
  | { kind: 'user'; text: string; /** Who sent it, when known. */ by?: string }
  | {
      kind: 'permission';
      requestId: string;
      /** The tool or action kind, e.g. Bash, Write, shell, execute. */
      tool: string;
      /** What the agent wants to do, in the vendor's words. */
      title: string;
      input: unknown;
      options: PermissionOption[];
      /** The option id chosen, once decided. */
      decision: string | null;
    }
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
  /**
   * Number of background jobs the agent has pending (a shell command it
   * left running, a wake-up it scheduled). The turn ends while they run
   * and the agent starts a new turn by itself when they finish, so an idle
   * agent with jobs pending is not "ready for more".
   */
  background?: number;
  ops?: ItemOp[];
  /** The vendor conversation id, once known. */
  conversationId?: string;
  /**
   * stdin lines to send in reaction to this record (protocol handshakes).
   * The manager sends them only for live records, never during replay, so
   * a restart never repeats a handshake.
   */
  send?: unknown[];
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
  startArgs(opts: {
    resume?: string | null;
    extraDirs?: string[];
    permissions?: Permissions;
  }): string[];
  /** stdin lines to send once the session is running and attached (protocol handshakes). */
  startLines?(opts: {
    cwd: string;
    resume?: string | null;
    permissions?: Permissions;
  }): unknown[];
  /**
   * Called once a replay of the session log has caught up. Returns the
   * handshake lines still owed to the process, judged from the whole log
   * (nothing logged: the full start; a reply logged without its follow-up:
   * the follow-up; everything logged: nothing), and releases decision
   * reservations whose answer the log does not contain. Replaces
   * `startLines` for a fresh session too, so there is one path.
   */
  afterReplay?(opts: {
    cwd: string;
    resume?: string | null;
    permissions?: Permissions;
  }): unknown[];
  /** Permission requests the vendor is waiting on, from the log so far. */
  pendingPermissions?(): PermissionRequest[];
  /** stdin lines answering a pending request with one of its options; null if no such request. */
  decide?(requestId: string, optionId: string): unknown[] | null;
  /** stdin lines for a user turn. */
  turn(text: string): unknown[];
  /** stdin lines to interrupt the current turn, if supported. */
  interrupt?(): unknown[];
  /** Whether the log so far shows a turn without its result yet. */
  turnInProgress?(): boolean;
  ingest(record: LogRecord): Ingest;
}

export interface AdapterFactory {
  readonly profile: string;
  create(): AgentAdapter;
}
