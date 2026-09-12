import type { LogRecord } from '../daemon/daemon-client.js';
export type AgentState = 'starting' | 'idle' | 'working' | 'waiting-input' | 'waiting-permission' | 'error' | 'exited';
export type Item = {
    kind: 'user';
    text: string;
} | {
    kind: 'text';
    text: string;
    streaming: boolean;
} | {
    kind: 'thinking';
    text: string;
} | {
    kind: 'tool_use';
    id: string;
    name: string;
    input: unknown;
} | {
    kind: 'tool_result';
    toolUseId: string;
    output: string;
    isError: boolean;
} | {
    kind: 'error';
    message: string;
} | {
    kind: 'system';
    text: string;
} | {
    kind: 'turn_end';
    usage?: Record<string, unknown>;
    costUsd?: number;
    durationMs?: number;
};
export type ItemOp = {
    op: 'append';
    item: Item;
    key?: string;
} | {
    op: 'update';
    key: string;
    item: Item;
};
export interface Ingest {
    state?: AgentState;
    error?: string;
    ops?: ItemOp[];
    conversationId?: string;
    send?: unknown[];
}
export interface AgentAdapter {
    readonly initialState?: AgentState;
    startArgs(opts: {
        resume?: string | null;
    }): string[];
    startLines?(opts: {
        cwd: string;
        resume?: string | null;
    }): unknown[];
    turn(text: string): unknown[];
    interrupt?(): unknown[];
    turnInProgress?(): boolean;
    ingest(record: LogRecord): Ingest;
}
export interface AdapterFactory {
    readonly profile: string;
    create(): AgentAdapter;
}
