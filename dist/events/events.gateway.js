var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var EventsGateway_1;
import { Logger } from '@nestjs/common';
import { WebSocketGateway, } from '@nestjs/websockets';
import { AgentsService } from '../agents/agents.service.js';
import { sessionIdFromCookieHeader } from '../auth/auth.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { DaemonClient } from '../daemon/daemon-client.js';
let EventsGateway = EventsGateway_1 = class EventsGateway {
    auth;
    agents;
    daemon;
    logger = new Logger(EventsGateway_1.name);
    clients = new Set();
    constructor(auth, agents, daemon) {
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
    }
    handleConnection(client, req) {
        const user = this.auth.userForSession(sessionIdFromCookieHeader(req.headers.cookie));
        if (!user) {
            client.close(4401, 'unauthorized');
            return;
        }
        this.clients.add(client);
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
        for (const c of this.clients) {
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
    __metadata("design:paramtypes", [AuthService,
        AgentsService,
        DaemonClient])
], EventsGateway);
export { EventsGateway };
//# sourceMappingURL=events.gateway.js.map