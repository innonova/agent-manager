import { OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit } from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import { AgentsService } from '../agents/agents.service.js';
import { AuthService } from '../auth/auth.service.js';
import { DaemonClient } from '../daemon/daemon-client.js';
export declare class EventsGateway implements OnGatewayInit, OnGatewayConnection<WebSocket>, OnGatewayDisconnect<WebSocket> {
    private readonly auth;
    private readonly agents;
    private readonly daemon;
    private readonly logger;
    private readonly clients;
    constructor(auth: AuthService, agents: AgentsService, daemon: DaemonClient);
    afterInit(): void;
    handleConnection(client: WebSocket, req: IncomingMessage): void;
    handleDisconnect(client: WebSocket): void;
    private broadcast;
}
