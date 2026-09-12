import type { LogRecord } from '../daemon/daemon-client.js';
import type { AgentAdapter, AdapterFactory, Ingest } from './adapter.js';
export declare class FakeAdapter implements AgentAdapter {
    private streamingText;
    startArgs({ resume }: {
        resume?: string | null;
    }): string[];
    turn(text: string): unknown[];
    interrupt(): unknown[];
    ingest(record: LogRecord): Ingest;
}
export declare const fakeAdapterFactory: AdapterFactory;
