export class CodexAdapter {
    nextId = 1;
    threadId = null;
    turnId = null;
    turnOpen = false;
    pending = new Map();
    textKeys = new Map();
    texts = new Map();
    startArgs() {
        return [];
    }
    startLines(opts) {
        this.resume = opts.resume ?? null;
        return [
            this.rpc('initialize', 'initialize', {
                clientInfo: {
                    name: 'agent-manager',
                    title: 'agent-manager',
                    version: '0.0.1',
                },
            }),
        ];
    }
    turnInProgress() {
        return this.turnOpen;
    }
    turn(text) {
        if (!this.threadId)
            return [];
        return [
            this.rpc('turn', 'turn/start', {
                threadId: this.threadId,
                input: [{ type: 'text', text }],
            }),
        ];
    }
    interrupt() {
        if (!this.threadId || !this.turnId)
            return [];
        return [
            this.rpc('interrupt', 'turn/interrupt', {
                threadId: this.threadId,
                turnId: this.turnId,
            }),
        ];
    }
    resume = null;
    rpc(kind, method, params) {
        const id = this.nextId++;
        this.pending.set(id, kind);
        return { jsonrpc: '2.0', id, method, params };
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
        if (line?.id !== undefined &&
            (line.result !== undefined || line.error !== undefined))
            return this.ingestReply(line);
        switch (line?.method) {
            case 'turn/started':
                this.turnId = line.params?.turn?.id ?? null;
                this.turnOpen = true;
                return { state: 'working' };
            case 'item/started':
                return this.ingestItem(line.params?.item, false);
            case 'item/completed':
                return this.ingestItem(line.params?.item, true);
            case 'item/agentMessage/delta': {
                const id = String(line.params?.itemId);
                const key = this.textKeys.get(id);
                if (!key)
                    return {};
                const text = (this.texts.get(id) ?? '') + String(line.params?.delta ?? '');
                this.texts.set(id, text);
                return {
                    ops: [
                        {
                            op: 'update',
                            key,
                            item: { kind: 'text', text, streaming: true },
                        },
                    ],
                };
            }
            case 'turn/completed': {
                this.turnOpen = false;
                this.turnId = null;
                const turn = line.params?.turn;
                const end = {
                    kind: 'turn_end',
                    durationMs: turn?.durationMs ?? undefined,
                };
                if (turn?.status === 'failed' || turn?.error) {
                    const message = String(turn?.error?.message ?? turn?.error ?? 'turn failed');
                    return {
                        state: 'error',
                        error: message,
                        ops: [append({ kind: 'error', message }), append(end)],
                    };
                }
                return {
                    state: turn?.status === 'interrupted' ? 'idle' : 'idle',
                    ops: [append(end)],
                };
            }
            case 'error': {
                const message = String(line.params?.error?.message ?? line.params?.message ?? record.d);
                this.turnOpen = false;
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
        if (typeof line?.id === 'number' && typeof line.method === 'string') {
            const kind = line.method === 'initialize'
                ? 'initialize'
                : line.method === 'thread/start' || line.method === 'thread/resume'
                    ? 'thread'
                    : line.method === 'turn/start'
                        ? 'turn'
                        : line.method === 'turn/interrupt'
                            ? 'interrupt'
                            : null;
            if (kind)
                this.pending.set(line.id, kind);
            if (line.id >= this.nextId)
                this.nextId = line.id + 1;
            if (kind === 'turn') {
                this.turnOpen = true;
                const text = (line.params?.input ?? [])
                    .filter((b) => b.type === 'text')
                    .map((b) => b.text)
                    .join('');
                return { state: 'working', ops: [append({ kind: 'user', text })] };
            }
            if (kind === 'interrupt')
                return {
                    ops: [append({ kind: 'system', text: 'interrupt requested' })],
                };
        }
        return {};
    }
    ingestReply(line) {
        const kind = this.pending.get(line.id);
        this.pending.delete(line.id);
        if (line.error) {
            const message = String(line.error.message ?? JSON.stringify(line.error));
            if (kind === 'turn')
                this.turnOpen = false;
            return {
                state: 'error',
                error: message,
                ops: [append({ kind: 'error', message })],
            };
        }
        switch (kind) {
            case 'initialize':
                return {
                    send: [
                        { jsonrpc: '2.0', method: 'initialized' },
                        this.resume
                            ? this.rpc('thread', 'thread/resume', {
                                threadId: this.resume,
                                approvalPolicy: 'never',
                                sandbox: 'danger-full-access',
                            })
                            : this.rpc('thread', 'thread/start', {
                                approvalPolicy: 'never',
                                sandbox: 'danger-full-access',
                            }),
                    ],
                };
            case 'thread': {
                this.threadId = line.result?.thread?.id ?? this.resume ?? null;
                return {
                    conversationId: this.threadId ?? undefined,
                    state: this.turnOpen ? 'working' : 'idle',
                };
            }
            default:
                return {};
        }
    }
    ingestItem(item, completed) {
        if (!item)
            return {};
        switch (item.type) {
            case 'agentMessage': {
                const id = String(item.id);
                if (!completed) {
                    const key = `msg${this.textKeys.size + 1}`;
                    this.textKeys.set(id, key);
                    this.texts.set(id, item.text ?? '');
                    return {
                        ops: [
                            {
                                op: 'append',
                                key,
                                item: { kind: 'text', text: item.text ?? '', streaming: true },
                            },
                        ],
                    };
                }
                const key = this.textKeys.get(id);
                const text = String(item.text ?? this.texts.get(id) ?? '');
                this.texts.delete(id);
                this.textKeys.delete(id);
                return key
                    ? {
                        ops: [
                            {
                                op: 'update',
                                key,
                                item: { kind: 'text', text, streaming: false },
                            },
                        ],
                    }
                    : { ops: [append({ kind: 'text', text, streaming: false })] };
            }
            case 'reasoning':
                return completed && item.text
                    ? { ops: [append({ kind: 'thinking', text: String(item.text) })] }
                    : {};
            case 'commandExecution':
                if (!completed)
                    return {
                        ops: [
                            append({
                                kind: 'tool_use',
                                id: String(item.id),
                                name: 'shell',
                                input: { command: item.command, cwd: item.cwd },
                            }),
                        ],
                    };
                return {
                    ops: [
                        append({
                            kind: 'tool_result',
                            toolUseId: String(item.id),
                            output: `${item.aggregatedOutput ?? ''}${item.exitCode != null ? `\n[exit code ${item.exitCode}]` : ''}`,
                            isError: item.exitCode != null && item.exitCode !== 0,
                        }),
                    ],
                };
            case 'fileChange':
                if (!completed)
                    return {
                        ops: [
                            append({
                                kind: 'tool_use',
                                id: String(item.id),
                                name: 'edit',
                                input: { changes: item.changes ?? item },
                            }),
                        ],
                    };
                return {
                    ops: [
                        append({
                            kind: 'tool_result',
                            toolUseId: String(item.id),
                            output: String(item.status ?? 'completed'),
                            isError: item.status === 'failed',
                        }),
                    ],
                };
            default:
                return {};
        }
    }
}
const append = (item) => ({ op: 'append', item });
export const codexAdapterFactory = {
    profile: 'codex',
    create: () => new CodexAdapter(),
};
//# sourceMappingURL=codex.adapter.js.map