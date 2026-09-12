import { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import type { ManagerConfig } from '../config/config.js';
export interface LogRecord {
    seq: number;
    t: number;
    s: 'out' | 'err' | 'in';
    d: string;
}
export interface DaemonSession {
    id: string;
    profile: string;
    label: string | null;
    command: string;
    args: string[];
    cwd: string;
    state: 'running' | 'exited';
    pid: number | null;
    exitCode: number | null;
    signal: string | null;
    exitReason: string | null;
    startedAt: number;
    exitedAt: number | null;
    lastSeq: number;
}
export interface DaemonProfile {
    name: string;
    description?: string;
    command: string;
    args: string[];
    cwd: string | null;
    env: Record<string, string>;
    loginShell: boolean;
}
export declare class DaemonError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
interface DaemonEvents {
    connected: [];
    disconnected: [];
    output: [id: string, record: LogRecord];
    changed: [session: DaemonSession];
}
type Frame = Record<string, unknown> & {
    type: string;
    ref?: string;
};
export declare class DaemonClient extends EventEmitter<DaemonEvents> implements OnModuleInit, OnModuleDestroy {
    private readonly config;
    private readonly logger;
    private ws;
    private pending;
    private nextRef;
    private closing;
    private backoff;
    private reconnectTimer;
    connected: boolean;
    constructor(config: ManagerConfig);
    onModuleInit(): void;
    onModuleDestroy(): void;
    private connect;
    private safeEmit;
    private onFrame;
    request<T extends Frame = Frame>(frame: Omit<Frame, 'ref'>): Promise<T>;
    listSessions(): Promise<DaemonSession[]>;
    getSession(id: string): Promise<DaemonSession>;
    listProfiles(): Promise<DaemonProfile[]>;
    start(req: {
        profile: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        label?: string;
    }): Promise<DaemonSession>;
    attach(id: string, fromSeq: number): Promise<number>;
    input(id: string, data: unknown): Promise<void>;
    endInput(id: string): Promise<void>;
    signal(id: string, signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): Promise<void>;
}
export {};
