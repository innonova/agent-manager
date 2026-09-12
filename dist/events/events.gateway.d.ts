import { OnModuleDestroy } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit } from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import { AgentsService } from '../agents/agents.service.js';
import { AuthService } from '../auth/auth.service.js';
import type { ManagerConfig } from '../config/config.js';
import { DaemonClient } from '../daemon/daemon-client.js';
import { FeaturesService } from '../features/features.service.js';
export declare class EventsGateway implements OnGatewayInit, OnGatewayConnection<WebSocket>, OnGatewayDisconnect<WebSocket>, OnModuleDestroy {
    private readonly config;
    private readonly auth;
    private readonly agents;
    private readonly daemon;
    private readonly features;
    private readonly logger;
    private readonly clients;
    private sweep;
    constructor(config: ManagerConfig, auth: AuthService, agents: AgentsService, daemon: DaemonClient, features: FeaturesService);
    afterInit(): void;
    onModuleDestroy(): void;
    handleConnection(client: WebSocket, req: IncomingMessage): void;
    handleDisconnect(client: WebSocket): void;
    private broadcast;
}
