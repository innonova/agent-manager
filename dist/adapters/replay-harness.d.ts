import type { AgentAdapter, AgentState, Item } from './adapter.js';
import type { LogRecord } from '../daemon/daemon-client.js';
export declare function loadFixture(vendor: string, name: string): LogRecord[];
export declare function replay(adapter: AgentAdapter, records: LogRecord[]): {
    items: Item[];
    states: AgentState[];
    sent: {
        afterSeq: number;
        line: any;
    }[];
    conversationId: string | undefined;
    error: string | undefined;
};
