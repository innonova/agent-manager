import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { MANAGER_CONFIG } from '../config/config.js';
import type { ManagerConfig } from '../config/config.js';

/** One remote manager this one fronts for. */
export interface Spoke {
  name: string;
  url: string;
  token: string;
}

export interface HostStatus {
  name: string;
  local: boolean;
  /** The hub's link to the spoke's event stream (always true for the local host). */
  connected: boolean;
  /** The host's own link to its daemon. */
  daemon: boolean;
}

export class SpokeError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`spoke replied ${status}`);
  }
}

const SEP = ':';
/** How long a spoke has to answer a proxied request or a list. */
const SPOKE_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 4_000;

/**
 * Hub mode: this manager also shows and drives the projects of other
 * managers ("spokes"), so one UI covers several machines. Spokes are
 * listed in `<dataDir>/spokes.json` (`[{ name, url, token }]`); the
 * token is the spoke's `AGENT_MANAGER_HUB_TOKEN`. Every id of a spoke's
 * project or agent is seen here as `<name>:<id>`; requests for such ids
 * are forwarded to the spoke as the acting user (`X-Acting-User`, which
 * the spoke creates on first sight), and the spoke's event stream is
 * fanned into this manager's with the ids prefixed. Nothing of a spoke
 * is stored here.
 */
@Injectable()
export class HubService
  extends EventEmitter<{
    frame: [frame: Record<string, unknown>];
    hosts: [hosts: HostStatus[]];
  }>
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(HubService.name);
  readonly spokes = new Map<string, Spoke>();
  private readonly links = new Map<
    string,
    {
      ws: WebSocket | null;
      connected: boolean;
      daemon: boolean;
      timer: NodeJS.Timeout | null;
      attempt: number;
    }
  >();
  private closed = false;
  /** The local host's daemon link, reported by the gateway. */
  localDaemon = true;

  constructor(@Inject(MANAGER_CONFIG) private readonly config: ManagerConfig) {
    super();
    for (const s of loadSpokes(config.spokesFile, this.logger))
      this.spokes.set(s.name, s);
  }

  get enabled(): boolean {
    return this.spokes.size > 0;
  }

  onModuleInit(): void {
    for (const s of this.spokes.values()) {
      this.links.set(s.name, {
        ws: null,
        connected: false,
        daemon: false,
        timer: null,
        attempt: 0,
      });
      this.connect(s);
    }
    if (this.enabled)
      this.logger.log(`hub for ${[...this.spokes.keys()].join(', ')}`);
  }

  onModuleDestroy(): void {
    this.closed = true;
    for (const l of this.links.values()) {
      if (l.timer) clearTimeout(l.timer);
      l.ws?.close();
    }
  }

  hosts(): HostStatus[] {
    return [
      {
        name: this.config.hostName,
        local: true,
        connected: true,
        daemon: this.localDaemon,
      },
      ...[...this.spokes.keys()].map((name) => {
        const l = this.links.get(name);
        return {
          name,
          local: false,
          connected: l?.connected ?? false,
          daemon: l?.daemon ?? false,
        };
      }),
    ];
  }

  /** `<spoke>:<id>` → the spoke and the id it knows; null for a local id. */
  split(id: string): { spoke: Spoke; id: string } | null {
    const i = id.indexOf(SEP);
    if (i <= 0) return null;
    const spoke = this.spokes.get(id.slice(0, i));
    return spoke ? { spoke, id: id.slice(i + 1) } : null;
  }

  prefix(spoke: string, id: string): string {
    return `${spoke}${SEP}${id}`;
  }

  /** A request to a spoke as the acting user; the body comes back with the spoke's ids prefixed. */
  async call<T = unknown>(
    spoke: Spoke,
    method: string,
    apiPath: string,
    actingUser: string,
    body?: unknown,
    timeoutMs = SPOKE_TIMEOUT_MS,
  ): Promise<{ status: number; body: T }> {
    const res = await fetch(spoke.url.replace(/\/$/, '') + apiPath, {
      method,
      headers: {
        authorization: `Bearer ${spoke.token}`,
        'x-acting-user': actingUser,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { statusCode: res.status, message: text };
    }
    return { status: res.status, body: prefixIds(spoke.name, data) as T };
  }

  /**
   * The projects of every spoke that answers in time, ids prefixed and
   * `host` set; a spoke that does not answer contributes nothing (its
   * host status says so).
   */
  async listRemoteProjects(actingUser: string): Promise<unknown[]> {
    const out: unknown[] = [];
    await Promise.all(
      [...this.spokes.values()].map(async (spoke) => {
        try {
          const r = await this.call<unknown[]>(
            spoke,
            'GET',
            '/api/projects',
            actingUser,
            undefined,
            LIST_TIMEOUT_MS,
          );
          if (r.status === 200 && Array.isArray(r.body))
            for (const row of r.body) out.push(withHost(row, spoke.name));
        } catch (err) {
          this.logger.warn(
            `spoke ${spoke.name}: projects not listed: ${(err as Error).message}`,
          );
        }
      }),
    );
    return out;
  }

  private connect(spoke: Spoke): void {
    if (this.closed) return;
    const link = this.links.get(spoke.name)!;
    const ws = new WebSocket(
      spoke.url.replace(/^http/, 'ws').replace(/\/$/, '') + '/api/events',
      {
        headers: {
          authorization: `Bearer ${spoke.token}`,
          'x-acting-user': 'hub',
        },
      },
    );
    link.ws = ws;
    ws.on('open', () => {
      link.attempt = 0;
    });
    ws.on('message', (data) => {
      let f: Record<string, unknown>;
      try {
        f = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (f.type === 'hello') {
        link.connected = true;
        link.daemon = Boolean(
          (f.daemon as { connected?: boolean } | undefined)?.connected,
        );
        this.emit('hosts', this.hosts());
        if (f.presence)
          this.emit(
            'frame',
            rewriteFrame(spoke.name, { type: 'presence', agents: f.presence }),
          );
        return;
      }
      if (f.type === 'daemon') {
        link.daemon = Boolean(f.connected);
        this.emit('hosts', this.hosts());
        return;
      }
      if (
        f.type === 'users.changed' ||
        f.type === 'ui.build' ||
        f.type === 'hosts'
      )
        return;
      this.emit('frame', rewriteFrame(spoke.name, f));
    });
    ws.on('error', (err) => {
      if (link.attempt === 0)
        this.logger.warn(`spoke ${spoke.name}: ${err.message}`);
    });
    ws.on('close', () => {
      const was = link.connected;
      link.ws = null;
      link.connected = false;
      if (was) this.emit('hosts', this.hosts());
      if (this.closed) return;
      const delay = Math.min(30_000, 1000 * 2 ** link.attempt++);
      link.timer = setTimeout(() => this.connect(spoke), delay);
      link.timer.unref();
    });
  }
}

function loadSpokes(file: string, logger: Logger): Spoke[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) throw new Error('not a list');
    const out: Spoke[] = [];
    for (const s of list as Record<string, unknown>[]) {
      const name = String(s.name ?? '');
      const url = String(s.url ?? '');
      const token = String(s.token ?? '');
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(name) ||
        !/^https?:\/\//.test(url) ||
        !token
      )
        throw new Error(`bad spoke entry ${JSON.stringify(s)}`);
      out.push({ name, url, token });
    }
    return out;
  } catch (err) {
    logger.error(`${path.basename(file)} ignored: ${(err as Error).message}`);
    return [];
  }
}

function withHost(row: unknown, host: string): unknown {
  if (row && typeof row === 'object' && 'project' in row) {
    const r = row as { project: Record<string, unknown> };
    return { ...r, project: { ...r.project, host } };
  }
  return row;
}

/**
 * Prefixes every project and agent id in a spoke's reply so the hub's
 * clients see one id space: `id` of a project or agent object,
 * `projectId`, `agentId`, `currentSessionId` stays (a daemon session id
 * is only ever used through its agent).
 */
export function prefixIds(host: string, v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => prefixIds(host, x));
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const isProjectOrAgent = 'repos' in o || 'profile' in o;
  for (const [k, val] of Object.entries(o)) {
    if (
      (k === 'projectId' ||
        k === 'agentId' ||
        (k === 'id' && isProjectOrAgent)) &&
      typeof val === 'string'
    )
      out[k] = `${host}:${val}`;
    else out[k] = prefixIds(host, val);
  }
  if ('repos' in o && typeof o.id === 'string') out.host = host;
  return out;
}

/** A spoke's event frame as the hub's clients should see it. */
export function rewriteFrame(
  host: string,
  f: Record<string, unknown>,
): Record<string, unknown> {
  const out = prefixIds(host, f) as Record<string, unknown>;
  if (f.type === 'presence' && f.agents && typeof f.agents === 'object') {
    const agents: Record<string, unknown> = {};
    for (const [id, users] of Object.entries(
      f.agents as Record<string, unknown>,
    ))
      agents[`${host}:${id}`] = users;
    out.agents = agents;
  }
  return out;
}
