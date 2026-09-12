import type { LogRecord } from '../daemon/daemon-client.js';
import type { AgentAdapter, AdapterFactory, Ingest } from './adapter.js';
export declare class ClaudeAdapter implements AgentAdapter {
    readonly initialState: "idle";
    private message;
    private streaming;
    private turnOpen;
    startArgs({ resume }: {
        resume?: string | null;
    }): string[];
    turn(text: string): unknown[];
    interrupt(): unknown[];
    ingest(record: LogRecord): Ingest;
    private ingestInput;
    private ingestStreamEvent;
    private ingestAssistant;
    private ingestToolResults;
    private ingestResult;
}
export declare const claudeAdapterFactory: AdapterFactory;
