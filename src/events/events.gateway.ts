import { Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
} from '@nestjs/websockets';
import fs from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import type { WebSocket } from 'ws';
import { AgentsService } from '../agents/agents.service.js';
import { AuthService } from '../auth/auth.service.js';
import { MANAGER_CONFIG } from '../config/config.js';
import type { ManagerConfig } from '../config/config.js';
import { DaemonClient } from '../daemon/daemon-client.js';
import { FeaturesService } from '../features/features.service.js';
import { HubService } from '../hub/hub.service.js';
import { originAllowed } from '../origin.js';

/**
 * `/api/events`: server-to-client stream of everything that changes.
 * Authenticated with the login cookie on upgrade (4401 otherwise), same
 * origin only (4403 otherwise). Logout closes the session's sockets and
 * expired sessions are swept once a minute.
 */
/** How long after the last typing report a user still counts as typing. */
const TYPING_TTL_MS = 5000;

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
  /** socket -> where its user is and whether they are typing there. */
  private readonly presence = new Map<
    WebSocket,
    { userId: string; name: string; agentId: string | null; typingAt: number }
  >();
  private presenceSweep: NodeJS.Timeout | null = null;
  private lastPresence = '';
  /** Id of the UI build being served (from build.json next to it); null when no UI is served. */
  private uiBuild: string | null = null;
  /** Sockets that answered the last ping (or are new); the rest are dead. */
  private readonly alive = new Set<WebSocket>();
  private sweep: NodeJS.Timeout | null = null;
  private pinger: NodeJS.Timeout | null = null;

  constructor(
    @Inject(MANAGER_CONFIG) private readonly config: ManagerConfig,
    private readonly auth: AuthService,
    private readonly agents: AgentsService,
    private readonly daemon: DaemonClient,
    private readonly features: FeaturesService,
    private readonly hub: HubService,
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
    // A hub: the spokes' streams, ids prefixed; their presence merged into
    // ours; their health as hosts; a spoke's stream coming back as a cue
    // for clients to refetch what they show of it.
    this.hub.on('frame', (frame) => this.broadcast(frame));
    this.hub.on('hosts', (hosts) => this.broadcast({ type: 'hosts', hosts }));
    this.hub.on('presence', () => this.broadcastPresence());
    this.hub.on('reconnected', (name) =>
      this.broadcast({ type: 'host.reconnected', name }),
    );
    this.daemon.on('connected', () =>
      this.broadcast({ type: 'hosts', hosts: this.hub.hosts() }),
    );
    this.daemon.on('disconnected', () =>
      this.broadcast({ type: 'hosts', hosts: this.hub.hosts() }),
    );
    this.daemon.on('disconnected', () =>
      this.broadcast({ type: 'daemon', connected: false }),
    );
    this.auth.on('users', (users) => {
      for (const p of this.presence.values()) {
        const u = users.find((x) => x.id === p.userId);
        if (u) p.name = u.name;
      }
      this.broadcast({ type: 'users.changed', users });
      this.broadcastPresence();
    });
    this.auth.on('revoked', (sessionId) => {
      for (const [c, sid] of this.clients)
        if (sid === sessionId) c.close(4401, 'logged out');
    });
    this.sweep = setInterval(() => {
      for (const [c, sid] of this.clients)
        if (!sid.startsWith('hub:') && !this.auth.userForSession(sid))
          c.close(4401, 'session expired'); // a hub's socket has a token, not a session
    }, 60_000);
    this.sweep.unref();
    // An idle websocket carries nothing, and reverse proxies close idle
    // tunnels (haproxy after 50 s by default). Pinging keeps them open
    // wherever the manager is deployed; a client that does not answer by
    // the next ping is gone and is dropped rather than kept as a ghost.
    void this.readUiBuild();
    this.pinger = setInterval(() => {
      // The same tick notices a UI-only deploy (the served build swapped
      // under us) and tells every tab, so the page needs no polling.
      void this.readUiBuild().then((changed) => {
        if (changed) this.broadcast({ type: 'ui.build', id: this.uiBuild });
      });
      for (const c of this.clients.keys()) {
        if (c.readyState !== c.OPEN) continue;
        if (!this.alive.has(c)) {
          c.terminate();
          this.clients.delete(c);
          continue;
        }
        this.alive.delete(c);
        c.ping();
      }
    }, this.config.eventsPingMs);
    this.pinger.unref();
  }

  /** Re-reads build.json; true when the id differs from the last read. */
  private async readUiBuild(): Promise<boolean> {
    if (!this.config.uiDir) return false;
    let id: string | null = null;
    try {
      const raw = await fs.readFile(
        path.join(this.config.uiDir, 'build.json'),
        'utf8',
      );
      const parsed = JSON.parse(raw) as { id?: unknown };
      id = typeof parsed.id === 'string' ? parsed.id : null;
    } catch {
      id = null;
    }
    // A read that fails (mid-swap, say) keeps the last known id as the
    // baseline; only a different id is a change.
    if (id === null || id === this.uiBuild) return false;
    const changed = this.uiBuild !== null;
    this.uiBuild = id;
    return changed;
  }

  onModuleDestroy(): void {
    if (this.sweep) clearInterval(this.sweep);
    if (this.pinger) clearInterval(this.pinger);
    if (this.presenceSweep) clearInterval(this.presenceSweep);
  }

  // ---- presence ------------------------------------------------------------

  /**
   * The one client-to-server frame: `{ type: 'presence', agentId, typing }`,
   * sent when a user opens an agent (or leaves, agentId null) and while
   * they type. Typing expires after a few seconds without a repeat; a
   * closed socket disappears at once. What is broadcast is per agent, per
   * user (two tabs of one user count once): `{ type: 'presence', agents:
   * { [agentId]: [{ userId, name, typing }] } }`.
   */
  private onClientMessage(client: WebSocket, raw: unknown): void {
    let frame: { type?: unknown; agentId?: unknown; typing?: unknown };
    try {
      frame = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (frame?.type !== 'presence') return;
    const p = this.presence.get(client);
    if (!p) return;
    // agent ids are uuids, on a hub prefixed with the spoke's name; anything else (a prototype key, say) is ignored
    p.agentId =
      typeof frame.agentId === 'string' &&
      /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,31}:)?[A-Za-z0-9-]{1,64}$/.test(
        frame.agentId,
      )
        ? frame.agentId
        : null;
    p.typingAt = frame.typing === true && p.agentId ? Date.now() : 0;
    this.broadcastPresence();
  }

  private presenceSnapshot(): Record<
    string,
    { userId: string; name: string; typing: boolean }[]
  > {
    const now = Date.now();
    const agents = new Map<
      string,
      Map<string, { userId: string; name: string; typing: boolean }>
    >();
    for (const p of this.presence.values()) {
      if (!p.agentId) continue;
      const typing = now - p.typingAt < TYPING_TTL_MS;
      let users = agents.get(p.agentId);
      if (!users) agents.set(p.agentId, (users = new Map()));
      const seen = users.get(p.userId);
      if (seen) seen.typing = seen.typing || typing;
      else users.set(p.userId, { userId: p.userId, name: p.name, typing });
    }
    const out: Record<
      string,
      { userId: string; name: string; typing: boolean }[]
    > = Object.assign(Object.create(null), this.hub.remotePresence());
    // a spoke's agent viewed both there and here: both sets of people, once each
    for (const [id, users] of agents) {
      const remote = (out[id] ?? []).filter(
        (u) =>
          !users.has(u.userId) &&
          ![...users.values()].some((v) => v.name === u.name),
      );
      out[id] = [...remote, ...users.values()];
    }
    return out;
  }

  /** Sends the snapshot to everyone when it differs from the last one sent. */
  private broadcastPresence(): void {
    const agents = this.presenceSnapshot();
    const key = JSON.stringify(agents);
    if (key === this.lastPresence) return;
    this.lastPresence = key;
    this.broadcast({ type: 'presence', agents });
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
    const { user, sessionId } = this.auth.userForHeaders(req.headers);
    if (!user) {
      client.close(4401, 'unauthorized');
      return;
    }
    // a hub's socket has no login session to be revoked with
    this.clients.set(client, sessionId ?? `hub:${user.name}`);
    this.alive.add(client);
    client.on('pong', () => this.alive.add(client));
    // A ping racing a client that just hung up raises an error on the
    // socket; without a listener it would reach the process-level handler.
    client.on('error', () => undefined);
    this.presence.set(client, {
      userId: user.id,
      name: user.name,
      agentId: null,
      typingAt: 0,
    });
    client.on('message', (raw) => this.onClientMessage(client, raw));
    if (!this.presenceSweep) {
      // typing expires by time, not by a message, so sweep for it
      this.presenceSweep = setInterval(() => this.broadcastPresence(), 2000);
      this.presenceSweep.unref();
    }
    client.send(
      JSON.stringify({
        type: 'hello',
        user: user.name,
        daemon: { connected: this.daemon.connected },
        presence: this.presenceSnapshot(),
        uiBuild: this.uiBuild,
        hosts: this.hub.hosts(),
      }),
    );
  }

  handleDisconnect(client: WebSocket): void {
    this.clients.delete(client);
    this.alive.delete(client);
    if (this.presence.delete(client)) this.broadcastPresence();
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
