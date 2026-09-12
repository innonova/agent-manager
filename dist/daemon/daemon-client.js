var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var DaemonClient_1;
import { Inject, Injectable, Logger, } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { MANAGER_CONFIG } from '../config/config.js';
export class DaemonError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
let DaemonClient = DaemonClient_1 = class DaemonClient extends EventEmitter {
    config;
    logger = new Logger(DaemonClient_1.name);
    ws = null;
    pending = new Map();
    nextRef = 1;
    closing = false;
    backoff = 500;
    reconnectTimer = null;
    connected = false;
    constructor(config) {
        super();
        this.config = config;
    }
    onModuleInit() {
        this.connect();
    }
    onModuleDestroy() {
        this.closing = true;
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        this.removeAllListeners();
        this.ws?.close();
    }
    connect() {
        if (this.closing)
            return;
        const ws = new WebSocket(this.config.daemonUrl);
        this.ws = ws;
        ws.on('open', () => {
            this.logger.log(`connected to daemon at ${this.config.daemonUrl}`);
            this.backoff = 500;
            this.connected = true;
            this.emit('connected');
        });
        ws.on('message', (data) => this.onFrame(JSON.parse(String(data))));
        ws.on('error', (err) => this.logger.warn(`daemon socket error: ${err.message}`));
        ws.on('close', () => {
            const was = this.connected;
            this.connected = false;
            this.ws = null;
            for (const p of this.pending.values())
                p.reject(new DaemonError('disconnected', 'daemon connection lost'));
            this.pending.clear();
            if (was)
                this.emit('disconnected');
            if (!this.closing) {
                this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
                this.backoff = Math.min(this.backoff * 2, 10_000);
            }
        });
    }
    onFrame(f) {
        if (f.ref !== undefined && this.pending.has(String(f.ref))) {
            const p = this.pending.get(String(f.ref));
            this.pending.delete(String(f.ref));
            if (f.type === 'error')
                p.reject(new DaemonError(String(f.code), String(f.message)));
            else
                p.resolve(f);
            return;
        }
        switch (f.type) {
            case 'session.output': {
                const { id, seq, t, s, d } = f;
                this.emit('output', id, { seq, t, s, d });
                return;
            }
            case 'session.exit':
                return;
            case 'session.changed': {
                const session = f.session;
                this.emit('changed', session);
                if (session.state === 'exited')
                    this.emit('exit', session);
                return;
            }
            case 'error':
                this.logger.warn(`daemon error without ref: ${String(f.code)} ${String(f.message)}`);
                return;
            default:
                return;
        }
    }
    request(frame) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return Promise.reject(new DaemonError('disconnected', 'daemon is not connected'));
        }
        const ref = String(this.nextRef++);
        return new Promise((resolve, reject) => {
            this.pending.set(ref, { resolve: resolve, reject });
            this.ws.send(JSON.stringify({ ...frame, ref }));
        });
    }
    listSessions() {
        return this.request({
            type: 'sessions.list',
        }).then((r) => r.sessions);
    }
    getSession(id) {
        return this.request({
            type: 'session.get',
            id,
        }).then((r) => r.session);
    }
    listProfiles() {
        return this.request({
            type: 'profiles.list',
        }).then((r) => r.profiles);
    }
    start(req) {
        return this.request({
            type: 'session.start',
            ...req,
        }).then((r) => {
            if (req.attach && r.attached === false)
                throw new DaemonError(r.attachError?.code ?? 'attach-failed', r.attachError?.message ?? 'attach failed');
            return r.session;
        });
    }
    attach(id, fromSeq) {
        return this.request({
            type: 'session.attach',
            id,
            replay: { fromSeq },
        }).then((r) => r.lastSeq);
    }
    async input(id, data) {
        await this.request({ type: 'session.input', id, data });
    }
    async endInput(id) {
        await this.request({ type: 'session.end-input', id });
    }
    async signal(id, signal) {
        await this.request({ type: 'session.signal', id, signal });
    }
};
DaemonClient = DaemonClient_1 = __decorate([
    Injectable(),
    __param(0, Inject(MANAGER_CONFIG)),
    __metadata("design:paramtypes", [Object])
], DaemonClient);
export { DaemonClient };
//# sourceMappingURL=daemon-client.js.map