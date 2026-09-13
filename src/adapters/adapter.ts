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
  | {
      kind: 'user';
      text: string;
      /** Who sent it, when known. */
      by?: string;
      /** Images sent with it, as they went to the agent. */
      images?: TurnImage[];
    }
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
/**
 * What the vendor says about the account's limits, as each reports it:
 * Claude its rolling windows in `rate_limit_event`, Codex its
 * `account/rateLimits/updated`, Copilot only the session's context use.
 */
export interface AccountUsage {
  /** Rolling windows, e.g. "5h" and "7d", with how much is used and when each resets (unix ms). */
  windows: { name: string; usedPercent: number; resetsAt: number | null }[];
  /** The vendor's verdict, when it gives one. */
  status?: 'ok' | 'warning' | 'rejected';
  plan?: string;
  /** The session's context window: tokens used of the size. */
  context?: { used: number; size: number };
  /** What this session has consumed so far: tokens (input includes cache reads and writes) and, when the vendor prices it, dollars. */
  spend?: {
    inputTokens: number;
    outputTokens: number;
    costUsd?: number;
    turns: number;
  };
  /** Who serves the model, when the vendor says (Claude: firstParty, bedrock, vertex). */
  provider?: string;
  /** When it was reported, unix ms. */
  at: number;
}

export interface Ingest {
  state?: AgentState;
  /** The account's usage, when the vendor reports it. */
  usage?: AccountUsage;
  /** The model the vendor reports as active, once known. */
  model?: string;
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
/** An image sent with a turn: base64, with its media type. */
export interface TurnImage {
  mediaType: string;
  data: string;
}

export interface AgentAdapter {
  /** State right after the process starts, before it has said anything. Default 'starting'. */
  readonly initialState?: AgentState;
  /** Extra daemon args for a new session; `resume` is the vendor conversation id. */
  startArgs(opts: {
    resume?: string | null;
    extraDirs?: string[];
    permissions?: Permissions;
    /** Vendor model name; undefined leaves the vendor's default. */
    model?: string | null;
    /** Vendor effort level; undefined leaves the vendor's default. */
    effort?: string | null;
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
  /**
   * The stdin line(s) for a message the agent should see during the turn
   * under way, at its next step, without interrupting it. Absent, or an
   * empty list, means the vendor cannot take one now; the manager queues
   * the message for the next turn instead.
   */
  steer?(text: string, images?: TurnImage[]): unknown[];
  /**
   * Cross-turn parsing state at a quiescent point (a turn end), as plain
   * JSON, so a restart can continue from a cached transcript without
   * replaying the whole log; `restore` is the inverse on a fresh adapter.
   */
  snapshot?(): unknown;
  restore?(state: unknown): void;
  /** Permission requests the vendor is waiting on, from the log so far. */
  pendingPermissions?(): PermissionRequest[];
  /** stdin lines answering a pending request with one of its options; null if no such request. */
  decide?(requestId: string, optionId: string): unknown[] | null;
  /** stdin lines for a user turn. */
  turn(text: string, images?: TurnImage[]): unknown[];
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
