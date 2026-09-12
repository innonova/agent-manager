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
var EventsGateway_1;
import { Inject, Logger } from '@nestjs/common';
import { WebSocketGateway, } from '@nestjs/websockets';
import { AgentsService } from '../agents/agents.service.js';
import { sessionIdFromCookieHeader } from '../auth/auth.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { MANAGER_CONFIG } from '../config/config.js';
import { DaemonClient } from '../daemon/daemon-client.js';
import { originAllowed } from '../origin.js';
let EventsGateway = EventsGateway_1 = class EventsGateway {
    config;
    auth;
    agents;
    daemon;
    logger = new Logger(EventsGateway_1.name);
    clients = new Map();
    sweep = null;
    constructor(config, auth, agents, daemon) {
        this.config = config;
        this.auth = auth;
        this.agents = agents;
        this.daemon = daemon;
    }
    afterInit() {
        this.agents.on('state', (agentId, projectId, status) => this.broadcast({ type: 'agent.state', agentId, projectId, status }));
        this.agents.on('item', (agentId, item) => this.broadcast({ type: 'agent.item', agentId, item }));
        this.agents.on('session', (agentId, session) => this.broadcast({ type: 'agent.session', agentId, session }));
        this.agents.on('counts', (projectId, counts) => this.broadcast({ type: 'project.counts', projectId, counts }));
        this.daemon.on('connected', () => this.broadcast({ type: 'daemon', connected: true }));
        this.daemon.on('disconnected', () => this.broadcast({ type: 'daemon', connected: false }));
        this.auth.on('revoked', (sessionId) => {
            for (const [c, sid] of this.clients)
                if (sid === sessionId)
                    c.close(4401, 'logged out');
        });
        this.sweep = setInterval(() => {
            for (const [c, sid] of this.clients)
                if (!this.auth.userForSession(sid))
                    c.close(4401, 'session expired');
        }, 60_000);
        this.sweep.unref();
    }
    onModuleDestroy() {
        if (this.sweep)
            clearInterval(this.sweep);
    }
    handleConnection(client, req) {
        if (!originAllowed(req.headers.origin, req.headers.host, this.config.publicOrigin)) {
            client.close(4403, 'origin not allowed');
            return;
        }
        const sessionId = sessionIdFromCookieHeader(req.headers.cookie);
        const user = this.auth.userForSession(sessionId);
        if (!user || !sessionId) {
            client.close(4401, 'unauthorized');
            return;
        }
        this.clients.set(client, sessionId);
        client.send(JSON.stringify({
            type: 'hello',
            user: user.name,
            daemon: { connected: this.daemon.connected },
        }));
    }
    handleDisconnect(client) {
        this.clients.delete(client);
    }
    broadcast(frame) {
        const data = JSON.stringify(frame);
        for (const c of this.clients.keys()) {
            if (c.readyState !== c.OPEN)
                continue;
            if (c.bufferedAmount > 16 * 1024 * 1024) {
                this.logger.warn('dropping slow event client');
                c.close(1008, 'slow consumer');
                this.clients.delete(c);
                continue;
            }
            c.send(data);
        }
    }
};
EventsGateway = EventsGateway_1 = __decorate([
    WebSocketGateway({ path: '/api/events' }),
    __param(0, Inject(MANAGER_CONFIG)),
    __metadata("design:paramtypes", [Object, AuthService,
        AgentsService,
        DaemonClient])
], EventsGateway);
export { EventsGateway };
//# sourceMappingURL=events.gateway.js.map