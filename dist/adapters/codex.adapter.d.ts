import type { LogRecord } from '../daemon/daemon-client.js';
import type { AgentAdapter, AdapterFactory, Ingest } from './adapter.js';
export declare class CodexAdapter implements AgentAdapter {
    private nextId;
    private threadId;
    private turnId;
    private turnOpen;
    private pending;
    private textKeys;
    private texts;
    startArgs(): string[];
    startLines(opts: {
        cwd: string;
        resume?: string | null;
    }): unknown[];
    turnInProgress(): boolean;
    turn(text: string): unknown[];
    interrupt(): unknown[];
    private resume;
    private rpc;
    ingest(record: LogRecord): Ingest;
    private ingestInput;
    private ingestReply;
    private ingestItem;
}
export declare const codexAdapterFactory: AdapterFactory;
