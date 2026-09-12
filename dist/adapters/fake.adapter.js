export class FakeAdapter {
    streamingText = '';
    textKey = '';
    texts = 0;
    turnOpen = false;
    startArgs({ resume }) {
        return resume ? ['--resume', resume] : [];
    }
    turn(text) {
        return [{ type: 'user', text }];
    }
    interrupt() {
        return [{ type: 'interrupt' }];
    }
    ingest(record) {
        if (record.s === 'err')
            return { ops: [append({ kind: 'system', text: record.d })] };
        let line;
        try {
            line = JSON.parse(record.d);
        }
        catch {
            return { ops: [append({ kind: 'system', text: record.d })] };
        }
        if (record.s === 'in') {
            if (line.type === 'user') {
                this.turnOpen = true;
                return {
                    state: 'working',
                    ops: [append({ kind: 'user', text: line.text })],
                };
            }
            if (line.type === 'interrupt')
                return {
                    ops: [append({ kind: 'system', text: 'interrupt requested' })],
                };
            return {};
        }
        switch (line.type) {
            case 'init':
                return {
                    conversationId: line.conversationId,
                    state: this.turnOpen ? 'working' : 'idle',
                };
            case 'text_start':
                this.streamingText = '';
                this.textKey = `t${++this.texts}`;
                return {
                    ops: [
                        {
                            op: 'append',
                            key: this.textKey,
                            item: { kind: 'text', text: '', streaming: true },
                        },
                    ],
                };
            case 'text_delta':
                this.streamingText += line.text;
                return {
                    ops: [
                        {
                            op: 'update',
                            key: this.textKey,
                            item: { kind: 'text', text: this.streamingText, streaming: true },
                        },
                    ],
                };
            case 'text_end':
                return {
                    ops: [
                        {
                            op: 'update',
                            key: this.textKey,
                            item: {
                                kind: 'text',
                                text: this.streamingText,
                                streaming: false,
                            },
                        },
                    ],
                };
            case 'thinking':
                return { ops: [append({ kind: 'thinking', text: line.text })] };
            case 'tool_use':
                return {
                    ops: [
                        append({
                            kind: 'tool_use',
                            id: line.id,
                            name: line.name,
                            input: line.input,
                        }),
                    ],
                };
            case 'tool_result':
                return {
                    ops: [
                        append({
                            kind: 'tool_result',
                            toolUseId: line.id,
                            output: line.output,
                            isError: Boolean(line.isError),
                        }),
                    ],
                };
            case 'result':
                this.turnOpen = false;
                return {
                    state: 'idle',
                    ops: [
                        append({
                            kind: 'turn_end',
                            durationMs: line.durationMs,
                            costUsd: 0,
                        }),
                    ],
                };
            case 'error':
                this.turnOpen = false;
                return {
                    state: 'error',
                    error: line.message,
                    ops: [
                        append({ kind: 'error', message: line.message }),
                        append({ kind: 'turn_end' }),
                    ],
                };
            default:
                return {};
        }
    }
}
const append = (item) => ({ op: 'append', item });
export const fakeAdapterFactory = {
    profile: 'fake',
    create: () => new FakeAdapter(),
};
//# sourceMappingURL=fake.adapter.js.map