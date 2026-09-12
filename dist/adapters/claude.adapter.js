export class ClaudeAdapter {
    initialState = 'idle';
    message = 0;
    streaming = null;
    turnOpen = false;
    startArgs({ resume }) {
        const args = ['--dangerously-skip-permissions'];
        if (resume)
            args.push('--resume', resume);
        return args;
    }
    turnInProgress() {
        return this.turnOpen;
    }
    turn(text) {
        return [{ type: 'user', message: { role: 'user', content: text } }];
    }
    interrupt() {
        return [
            {
                type: 'control_request',
                request_id: `interrupt-${Date.now()}`,
                request: { subtype: 'interrupt' },
            },
        ];
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
        if (record.s === 'in')
            return this.ingestInput(line);
        switch (line?.type) {
            case 'system':
                if (line.subtype === 'init')
                    return {
                        conversationId: line.session_id,
                        state: this.turnOpen ? 'working' : 'idle',
                    };
                return {};
            case 'stream_event':
                return this.ingestStreamEvent(line.event);
            case 'assistant':
                return this.ingestAssistant(line.message);
            case 'user':
                return this.ingestToolResults(line);
            case 'result':
                return this.ingestResult(line);
            case 'error': {
                this.turnOpen = false;
                const message = String(line.message ?? line.error ?? record.d);
                return {
                    state: 'error',
                    error: message,
                    ops: [append({ kind: 'error', message })],
                };
            }
            default:
                return {};
        }
    }
    ingestInput(line) {
        if (line?.type === 'user') {
            const c = line.message?.content;
            const text = typeof c === 'string'
                ? c
                : Array.isArray(c)
                    ? c
                        .filter((b) => b.type === 'text')
                        .map((b) => b.text)
                        .join('')
                    : '';
            this.turnOpen = true;
            this.streaming = null;
            return { state: 'working', ops: [append({ kind: 'user', text })] };
        }
        if (line?.type === 'control_request' &&
            line.request?.subtype === 'interrupt') {
            return { ops: [append({ kind: 'system', text: 'interrupt requested' })] };
        }
        return {};
    }
    ingestStreamEvent(ev) {
        switch (ev?.type) {
            case 'message_start':
                this.message++;
                return {};
            case 'content_block_start': {
                const block = ev.content_block;
                const key = `m${this.message}b${ev.index}`;
                if (block?.type === 'text') {
                    this.streaming = {
                        key,
                        index: ev.index,
                        kind: 'text',
                        text: block.text ?? '',
                    };
                    return {
                        ops: [
                            {
                                op: 'append',
                                key,
                                item: {
                                    kind: 'text',
                                    text: this.streaming.text,
                                    streaming: true,
                                },
                            },
                        ],
                    };
                }
                if (block?.type === 'thinking') {
                    this.streaming = {
                        key,
                        index: ev.index,
                        kind: 'thinking',
                        text: block.thinking ?? '',
                    };
                }
                return {};
            }
            case 'content_block_delta': {
                const s = this.streaming;
                if (!s || ev.index !== s.index)
                    return {};
                if (s.kind === 'text' && ev.delta?.type === 'text_delta') {
                    s.text += ev.delta.text;
                    return {
                        ops: [
                            {
                                op: 'update',
                                key: s.key,
                                item: { kind: 'text', text: s.text, streaming: true },
                            },
                        ],
                    };
                }
                if (s.kind === 'thinking' &&
                    ev.delta?.type === 'thinking_delta' &&
                    ev.delta.thinking) {
                    s.text += ev.delta.thinking;
                    return {
                        ops: [
                            {
                                op: 'update',
                                key: s.key,
                                item: { kind: 'thinking', text: s.text },
                            },
                        ],
                    };
                }
                return {};
            }
            case 'content_block_stop': {
                const s = this.streaming;
                if (s && ev.index === s.index) {
                    this.streaming = null;
                    if (s.kind === 'text')
                        return {
                            ops: [
                                {
                                    op: 'update',
                                    key: s.key,
                                    item: { kind: 'text', text: s.text, streaming: false },
                                },
                            ],
                        };
                }
                return {};
            }
            default:
                return {};
        }
    }
    ingestAssistant(message) {
        const ops = [];
        const s = this.streaming;
        for (const block of message?.content ?? []) {
            switch (block.type) {
                case 'text':
                    if (!block.text)
                        break;
                    if (s?.kind === 'text')
                        ops.push({
                            op: 'update',
                            key: s.key,
                            item: { kind: 'text', text: block.text, streaming: false },
                        });
                    else
                        ops.push(append({ kind: 'text', text: block.text, streaming: false }));
                    break;
                case 'thinking':
                    if (!block.thinking)
                        break;
                    if (s?.kind === 'thinking' && s.text)
                        ops.push({
                            op: 'update',
                            key: s.key,
                            item: { kind: 'thinking', text: block.thinking },
                        });
                    else
                        ops.push(append({ kind: 'thinking', text: block.thinking }));
                    break;
                case 'tool_use':
                    ops.push(append({
                        kind: 'tool_use',
                        id: block.id,
                        name: block.name,
                        input: block.input,
                    }));
                    break;
                default:
                    break;
            }
        }
        this.streaming = null;
        return { ops };
    }
    ingestToolResults(line) {
        if (line.isReplay)
            return {};
        const ops = [];
        for (const block of Array.isArray(line.message?.content)
            ? line.message.content
            : []) {
            if (block.type !== 'tool_result')
                continue;
            const output = typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                    ? block.content
                        .map((c) => c.type === 'text' ? c.text : JSON.stringify(c))
                        .join('\n')
                    : '';
            ops.push(append({
                kind: 'tool_result',
                toolUseId: block.tool_use_id,
                output,
                isError: Boolean(block.is_error),
            }));
        }
        return { ops };
    }
    ingestResult(line) {
        this.turnOpen = false;
        this.streaming = null;
        const end = {
            kind: 'turn_end',
            usage: line.usage,
            costUsd: line.total_cost_usd,
            durationMs: line.duration_ms,
        };
        if (line.is_error) {
            const message = Array.isArray(line.errors) && line.errors.length
                ? line.errors.map(String).join('\n')
                : typeof line.result === 'string' && line.result
                    ? line.result
                    : String(line.subtype ?? 'error');
            return {
                state: 'error',
                error: message,
                ops: [append({ kind: 'error', message }), append(end)],
                conversationId: line.session_id,
            };
        }
        return {
            state: 'idle',
            ops: [append(end)],
            conversationId: line.session_id,
        };
    }
}
const append = (item) => ({ op: 'append', item });
export const claudeAdapterFactory = {
    profile: 'claude',
    create: () => new ClaudeAdapter(),
};
//# sourceMappingURL=claude.adapter.js.map