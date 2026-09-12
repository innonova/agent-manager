import type { LogRecord } from '../daemon/daemon-client.js';
import type { AgentAdapter, AdapterFactory, Ingest } from './adapter.js';
export declare class CopilotAdapter implements AgentAdapter {
    private nextId;
    private sessionId;
    private turnOpen;
    private pending;
    private textKey;
    private text;
    private texts;
    private thoughtKey;
    private thought;
    private cwd;
    private resume;
    startArgs({ extraDirs, }?: {
        resume?: string | null;
        extraDirs?: string[];
    }): string[];
    startLines(opts: {
        cwd: string;
        resume?: string | null;
    }): unknown[];
    turnInProgress(): boolean;
    turn(text: string): unknown[];
    interrupt(): unknown[];
    private rpc;
    ingest(record: LogRecord): Ingest;
    private ingestInput;
    private ingestReply;
    private ingestUpdate;
    private endText;
}
export declare const copilotAdapterFactory: AdapterFactory;
