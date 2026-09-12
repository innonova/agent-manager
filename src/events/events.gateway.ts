import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import { AgentsService } from '../agents/agents.service.js';
import { sessionIdFromCookieHeader } from '../auth/auth.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { DaemonClient } from '../daemon/daemon-client.js';

/**
 * `/api/events`: server-to-client stream of everything that changes.
 * Authenticated with the login cookie on upgrade; unauthenticated sockets
 * are closed with 4401 before receiving anything.
 */
@WebSocketGateway({ path: '/api/events' })
export class EventsGateway
  implements
    OnGatewayInit,
    OnGatewayConnection<WebSocket>,
    OnGatewayDisconnect<WebSocket>
{
  private readonly logger = new Logger(EventsGateway.name);
  private readonly clients = new Set<WebSocket>();

  constructor(
    private readonly auth: AuthService,
    private readonly agents: AgentsService,
    private readonly daemon: DaemonClient,
  ) {}

  afterInit(): void {
    this.agents.on('state', (agentId, projectId, status) =>
      this.broadcast({ type: 'agent.state', agentId, projectId, status }),
    );
    this.agents.on('item', (agentId, item) =>
      this.broadcast({ type: 'agent.item', agentId, item }),
    );
    this.agents.on('session', (agentId, session) =>
      this.broadcast({ type: 'agent.session', agentId, session }),
    );
    this.agents.on('counts', (projectId, counts) =>
      this.broadcast({ type: 'project.counts', projectId, counts }),
    );
    this.daemon.on('connected', () =>
      this.broadcast({ type: 'daemon', connected: true }),
    );
    this.daemon.on('disconnected', () =>
      this.broadcast({ type: 'daemon', connected: false }),
    );
  }

  handleConnection(client: WebSocket, req: IncomingMessage): void {
    const user = this.auth.userForSession(
      sessionIdFromCookieHeader(req.headers.cookie),
    );
    if (!user) {
      client.close(4401, 'unauthorized');
      return;
    }
    this.clients.add(client);
    client.send(
      JSON.stringify({
        type: 'hello',
        user: user.name,
        daemon: { connected: this.daemon.connected },
      }),
    );
  }

  handleDisconnect(client: WebSocket): void {
    this.clients.delete(client);
  }

  private broadcast(frame: Record<string, unknown>): void {
    const data = JSON.stringify(frame);
    for (const c of this.clients) {
      if (c.readyState !== c.OPEN) continue;
      if (c.bufferedAmount > 16 * 1024 * 1024) {
        this.logger.warn('dropping slow event client');
        c.close(1008, 'slow consumer');
        this.clients.delete(c);
        continue;
      }
      c.send(data);
    }
  }
}
