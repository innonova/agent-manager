import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import webPush from 'web-push';
import { AgentsService, MANAGER_AUTHOR } from '../agents/agents.service.js';
import type { AgentStatus } from '../agents/agents.service.js';
import type { AgentState } from '../adapters/adapter.js';
import { MANAGER_CONFIG } from '../config/config.js';
import type { ManagerConfig } from '../config/config.js';
import { DbService } from '../db/db.service.js';

export interface PushPayload {
  title: string;
  body: string;
  /** Where a tap goes, a path on this UI. */
  url: string;
  /** One notification per agent at a time: a new one replaces the old. */
  tag: string;
}

interface SubscriptionRow {
  endpoint: string;
  user_id: string;
  p256dh: string;
  auth: string;
}

/**
 * Web push to the phones (and browsers) that asked for it: what the
 * desktop notification says in a tab, sent through the push services so
 * it arrives with the tab closed and the phone in a pocket. A key pair
 * of this install's own, made on first start into the data dir; a
 * subscription per browser, kept by user; and one send per event the
 * desktop notification would show, with the same words: an agent that
 * needs input, one that failed, one that finished a turn a person sent.
 * A subscription the push service says is gone is dropped on its word.
 */
@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private keys: { publicKey: string; privateKey: string } | null = null;
  private readonly lastState = new Map<string, AgentState>();
  /** Set in tests: the send, so nothing reaches a push service. */
  send: (sub: webPush.PushSubscription, payload: string) => Promise<unknown> = (
    sub,
    payload,
  ) => webPush.sendNotification(sub, payload, { TTL: 3600 });

  constructor(
    @Inject(MANAGER_CONFIG) private readonly config: ManagerConfig,
    private readonly dbs: DbService,
    private readonly agents: AgentsService,
  ) {}

  private get db() {
    return this.dbs.db;
  }

  onModuleInit(): void {
    this.loadKeys();
    this.agents.on(
      'state',
      (agentId, projectId, status) =>
        void this.onState(agentId, projectId, status).catch((err: Error) =>
          this.logger.warn(`push after a state change failed: ${err.message}`),
        ),
    );
  }

  /** The install's VAPID pair: made once, kept at `<dataDir>/push-keys.json` (mode 600). */
  private loadKeys(): void {
    const file = path.join(this.config.dataDir, 'push-keys.json');
    try {
      this.keys = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.keys = webPush.generateVAPIDKeys();
      fs.mkdirSync(this.config.dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(this.keys, null, 2), {
        mode: 0o600,
      });
      this.logger.log('made a push key pair');
    }
    // the contact a push service may use: the public origin when there is one
    const subject =
      this.config.publicOrigin ?? 'mailto:agent-manager@localhost';
    webPush.setVapidDetails(
      subject,
      this.keys!.publicKey,
      this.keys!.privateKey,
    );
  }

  publicKey(): string {
    return this.keys!.publicKey;
  }

  subscribe(
    userId: string,
    sub: unknown,
    userAgent: string | null,
  ): { count: number } {
    const s = sub as {
      endpoint?: unknown;
      keys?: { p256dh?: unknown; auth?: unknown };
    } | null;
    if (
      !s ||
      typeof s.endpoint !== 'string' ||
      !s.endpoint.startsWith('https://') ||
      typeof s.keys?.p256dh !== 'string' ||
      typeof s.keys?.auth !== 'string'
    )
      throw new BadRequestException(
        '"subscription" must be a push subscription (endpoint, keys)',
      );
    this.db
      .prepare(
        'INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent',
      )
      .run(
        s.endpoint,
        userId,
        s.keys.p256dh,
        s.keys.auth,
        userAgent,
        Date.now(),
      );
    return { count: this.count(userId) };
  }

  unsubscribe(userId: string, endpoint: unknown): { count: number } {
    if (typeof endpoint !== 'string')
      throw new BadRequestException('"endpoint" is required');
    this.db
      .prepare(
        'DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?',
      )
      .run(endpoint, userId);
    return { count: this.count(userId) };
  }

  /** How many of this user's browsers are subscribed. */
  count(userId: string): number {
    return (
      this.db
        .prepare(
          'SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?',
        )
        .get(userId) as { n: number }
    ).n;
  }

  /** Sends to every subscription of a user (or of everyone, with null); drops the ones the service says are gone. */
  async notify(userId: string | null, payload: PushPayload): Promise<number> {
    const rows = (
      userId === null
        ? this.db.prepare('SELECT * FROM push_subscriptions').all()
        : this.db
            .prepare('SELECT * FROM push_subscriptions WHERE user_id = ?')
            .all(userId)
    ) as SubscriptionRow[];
    let sent = 0;
    for (const r of rows) {
      try {
        await this.send(
          { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } },
          JSON.stringify(payload),
        );
        sent++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          this.db
            .prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')
            .run(r.endpoint);
          this.logger.log(`push subscription gone (${status}); dropped`);
        } else this.logger.warn(`push failed: ${(err as Error).message}`);
      }
    }
    return sent;
  }

  /**
   * The desktop notification's rule, server side: an agent that needs
   * input, one that failed, one that finished a turn a person sent
   * (a helper's turn sent by another agent, or the manager's own poke,
   * is nobody's wait). Everyone subscribed hears; the people here are
   * the few who run the place.
   */
  private async onState(
    agentId: string,
    projectId: string,
    status: AgentStatus,
  ): Promise<void> {
    const was = this.lastState.get(agentId);
    this.lastState.set(agentId, status.state);
    if (was === undefined) return; // first sight after a start: nothing happened yet
    const now = status.state;
    let text: string | null = null;
    if (now === 'waiting-input' || now === 'waiting-permission') {
      if (was !== now) text = 'needs your input';
    } else if (now === 'error') {
      if (was !== 'error') text = `failed: ${status.error ?? 'error'}`;
    } else if (now === 'idle' && was === 'working' && !status.background) {
      const by = this.agents.lastTurnBy(agentId);
      if (by && by !== MANAGER_AUTHOR && !by.startsWith('agent-'))
        text = 'is ready for more';
    }
    if (!text) return;
    let agent;
    try {
      agent = this.agents.get(agentId);
    } catch {
      return; // forgotten meanwhile
    }
    await this.notify(null, {
      title: `${agent.name} ${text}`,
      body: 'agent-manager',
      url: `/projects/${projectId}/agents/${agentId}`,
      tag: `agent-${agentId}`,
    });
  }
}
