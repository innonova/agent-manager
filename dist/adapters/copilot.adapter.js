export class CopilotAdapter {
    nextId = 1;
    sessionId = null;
    turnOpen = false;
    pending = new Map();
    textKey = null;
    text = '';
    texts = 0;
    thoughtKey = null;
    thought = '';
    cwd = '';
    resume = null;
    startArgs() {
        return ['--allow-all'];
    }
    startLines(opts) {
        this.cwd = opts.cwd;
        this.resume = opts.resume ?? null;
        return [
            this.rpc('initialize', {
                protocolVersion: 1,
                clientCapabilities: {
                    fs: { readTextFile: false, writeTextFile: false },
                    terminal: false,
                },
            }),
        ];
    }
    turnInProgress() {
        return this.turnOpen;
    }
    turn(text) {
        if (!this.sessionId)
            return [];
        return [
            this.rpc('prompt', {
                sessionId: this.sessionId,
                prompt: [{ type: 'text', text }],
            }),
        ];
    }
    interrupt() {
        if (!this.sessionId)
            return [];
        return [
            {
                jsonrpc: '2.0',
                method: 'session/cancel',
                params: { sessionId: this.sessionId },
            },
        ];
    }
    rpc(kind, params) {
        const method = {
            initialize: 'initialize',
            session: this.resume ? 'session/load' : 'session/new',
            prompt: 'session/prompt',
            cancel: 'session/cancel',
        }[kind];
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
        if (line?.id !== undefined && line.method === undefined)
            return this.ingestReply(line);
        switch (line?.method) {
            case 'session/update':
                return this.ingestUpdate(line.params?.update);
            case 'session/request_permission': {
                const options = line.params?.options ?? [];
                const opt = options.find((o) => String(o.kind).startsWith('allow')) ?? options[0];
                return {
                    ops: [
                        append({
                            kind: 'system',
                            text: `permission auto-granted: ${line.params?.toolCall?.title ?? 'tool call'}`,
                        }),
                    ],
                    send: [
                        {
                            jsonrpc: '2.0',
                            id: line.id,
                            result: {
                                outcome: { outcome: 'selected', optionId: opt?.optionId },
                            },
                        },
                    ],
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
                : line.method === 'session/new' || line.method === 'session/load'
                    ? 'session'
                    : line.method === 'session/prompt'
                        ? 'prompt'
                        : null;
            if (kind)
                this.pending.set(line.id, kind);
            if (line.id >= this.nextId)
                this.nextId = line.id + 1;
            if (kind === 'prompt') {
                this.turnOpen = true;
                this.endText();
                const text = (line.params?.prompt ?? [])
                    .filter((b) => b.type === 'text')
                    .map((b) => b.text)
                    .join('');
                return { state: 'working', ops: [append({ kind: 'user', text })] };
            }
        }
        if (line?.method === 'session/cancel')
            return { ops: [append({ kind: 'system', text: 'interrupt requested' })] };
        return {};
    }
    ingestReply(line) {
        const kind = this.pending.get(line.id);
        this.pending.delete(line.id);
        if (line.error) {
            const message = String(line.error.message ?? JSON.stringify(line.error));
            if (kind === 'prompt')
                this.turnOpen = false;
            const ops = [
                ...this.endText(),
                append({ kind: 'error', message }),
            ];
            if (kind === 'prompt')
                ops.push(append({ kind: 'turn_end' }));
            return { state: 'error', error: message, ops };
        }
        switch (kind) {
            case 'initialize':
                return {
                    send: [
                        this.rpc('session', this.resume
                            ? { sessionId: this.resume, cwd: this.cwd, mcpServers: [] }
                            : { cwd: this.cwd, mcpServers: [] }),
                    ],
                };
            case 'session':
                this.sessionId = line.result?.sessionId ?? this.resume ?? null;
                return {
                    conversationId: this.sessionId ?? undefined,
                    state: this.turnOpen ? 'working' : 'idle',
                };
            case 'prompt': {
                this.turnOpen = false;
                const usage = line.result?.usage;
                return {
                    state: 'idle',
                    ops: [...this.endText(), append({ kind: 'turn_end', usage })],
                };
            }
            default:
                return {};
        }
    }
    ingestUpdate(u) {
        switch (u?.sessionUpdate) {
            case 'agent_message_chunk': {
                const chunk = u.content?.type === 'text' ? String(u.content.text) : '';
                if (!this.textKey) {
                    this.textKey = `t${++this.texts}`;
                    this.text = chunk;
                    return {
                        ops: [
                            {
                                op: 'append',
                                key: this.textKey,
                                item: { kind: 'text', text: this.text, streaming: true },
                            },
                        ],
                    };
                }
                this.text += chunk;
                return {
                    ops: [
                        {
                            op: 'update',
                            key: this.textKey,
                            item: { kind: 'text', text: this.text, streaming: true },
                        },
                    ],
                };
            }
            case 'agent_thought_chunk': {
                const chunk = u.content?.type === 'text' ? String(u.content.text) : '';
                if (!this.thoughtKey) {
                    this.thoughtKey = `th${++this.texts}`;
                    this.thought = chunk;
                    return {
                        ops: [
                            {
                                op: 'append',
                                key: this.thoughtKey,
                                item: { kind: 'thinking', text: this.thought },
                            },
                        ],
                    };
                }
                this.thought += chunk;
                return {
                    ops: [
                        {
                            op: 'update',
                            key: this.thoughtKey,
                            item: { kind: 'thinking', text: this.thought },
                        },
                    ],
                };
            }
            case 'tool_call': {
                this.thoughtKey = null;
                return {
                    ops: [
                        ...this.endText(),
                        append({
                            kind: 'tool_use',
                            id: String(u.toolCallId),
                            name: String(u.title ?? u.kind ?? 'tool'),
                            input: u.rawInput ?? null,
                        }),
                    ],
                };
            }
            case 'tool_call_update': {
                if (u.status !== 'completed' && u.status !== 'failed')
                    return {};
                const output = Array.isArray(u.content)
                    ? u.content
                        .map((c) => c.type === 'content' && c.content?.type === 'text'
                        ? c.content.text
                        : c.type === 'diff'
                            ? `--- ${c.path}\n${c.newText ?? ''}`
                            : JSON.stringify(c))
                        .join('\n')
                    : String(u.rawOutput?.content ?? '');
                return {
                    ops: [
                        append({
                            kind: 'tool_result',
                            toolUseId: String(u.toolCallId),
                            output,
                            isError: u.status === 'failed',
                        }),
                    ],
                };
            }
            default:
                return {};
        }
    }
    endText() {
        if (!this.textKey)
            return [];
        const op = {
            op: 'update',
            key: this.textKey,
            item: { kind: 'text', text: this.text, streaming: false },
        };
        this.textKey = null;
        this.text = '';
        this.thoughtKey = null;
        return [op];
    }
}
const append = (item) => ({ op: 'append', item });
export const copilotAdapterFactory = {
    profile: 'copilot',
    create: () => new CopilotAdapter(),
};
//# sourceMappingURL=copilot.adapter.js.map