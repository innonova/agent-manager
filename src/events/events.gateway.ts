import { Inject, Logger, OnModuleDestroy } from '@nestjs/common';
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
import { MANAGER_CONFIG } from '../config/config.js';
import type { ManagerConfig } from '../config/config.js';
import { DaemonClient } from '../daemon/daemon-client.js';
import { FeaturesService } from '../features/features.service.js';
import { originAllowed } from '../origin.js';

/**
 * `/api/events`: server-to-client stream of everything that changes.
 * Authenticated with the login cookie on upgrade (4401 otherwise), same
 * origin only (4403 otherwise). Logout closes the session's sockets and
 * expired sessions are swept once a minute.
 */
@WebSocketGateway({ path: '/api/events' })
export class EventsGateway
  implements
    OnGatewayInit,
    OnGatewayConnection<WebSocket>,
    OnGatewayDisconnect<WebSocket>,
    OnModuleDestroy
{
  private readonly logger = new Logger(EventsGateway.name);
  /** socket -> the login session it was authenticated with */
  private readonly clients = new Map<WebSocket, string>();
  private sweep: NodeJS.Timeout | null = null;

  constructor(
    @Inject(MANAGER_CONFIG) private readonly config: ManagerConfig,
    private readonly auth: AuthService,
    private readonly agents: AgentsService,
    private readonly daemon: DaemonClient,
    private readonly features: FeaturesService,
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
    this.agents.on('reset', (agentId) =>
      this.broadcast({ type: 'agent.reset', agentId }),
    );
    this.features.on('changed', (projectId, feature) =>
      this.broadcast({ type: 'feature.changed', projectId, feature }),
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
    this.auth.on('revoked', (sessionId) => {
      for (const [c, sid] of this.clients)
        if (sid === sessionId) c.close(4401, 'logged out');
    });
    this.sweep = setInterval(() => {
      for (const [c, sid] of this.clients)
        if (!this.auth.userForSession(sid)) c.close(4401, 'session expired');
    }, 60_000);
    this.sweep.unref();
  }

  onModuleDestroy(): void {
    if (this.sweep) clearInterval(this.sweep);
  }

  handleConnection(client: WebSocket, req: IncomingMessage): void {
    if (
      !originAllowed(
        req.headers.origin,
        req.headers.host,
        this.config.publicOrigin,
      )
    ) {
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
    for (const c of this.clients.keys()) {
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
