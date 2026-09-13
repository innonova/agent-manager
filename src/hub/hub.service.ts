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
import { DaemonClient } from '../daemon/daemon-client.js';

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
  /** The last request the hub made of it failed; what it said. */
  error?: string;
}

type PresenceMap = Record<
  string,
  { userId: string; name: string; typing: boolean }[]
>;

const SEP = ':';
/** How long a spoke has to answer a proxied request or a list. */
const SPOKE_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 4_000;
/** A spoke socket that has not opened, or not sent anything (it pings every 25 s), by then is dead. */
const OPEN_TIMEOUT_MS = 10_000;
const SILENCE_TIMEOUT_MS = 90_000;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
/** Ids on a spoke are uuids; anything else is not forwarded (a `..` would leave the project/agent routes). */
export const REMOTE_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

interface Link {
  ws: WebSocket | null;
  connected: boolean;
  daemon: boolean;
  timer: NodeJS.Timeout | null;
  deadline: NodeJS.Timeout | null;
  attempt: number;
  /** The spoke's presence picture, ids prefixed; merged into the hub's. */
  presence: PresenceMap;
  error?: string;
}

/**
 * Hub mode: this manager also shows and drives the projects of other
 * managers ("spokes"), so one UI covers several machines. Spokes are
 * listed in `<dataDir>/spokes.json` (`[{ name, url, token }]`, the file
 * readable by this user only); the token is the spoke's
 * `AGENT_MANAGER_HUB_TOKEN`. Every id of a spoke's project or agent is
 * seen here as `<name>:<id>`; requests for such ids are forwarded to the
 * spoke as the acting user (`X-Acting-User`, which the spoke creates on
 * first sight), and the spoke's event stream is fanned into this
 * manager's with the ids prefixed. Nothing of a spoke is stored here.
 */
@Injectable()
export class HubService
  extends EventEmitter<{
    frame: [frame: Record<string, unknown>];
    hosts: [hosts: HostStatus[]];
    presence: [];
    /** A spoke's stream came back after a gap: clients should refetch what they show of it. */
    reconnected: [name: string];
  }>
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(HubService.name);
  readonly spokes = new Map<string, Spoke>();
  private readonly links = new Map<string, Link>();
  private closed = false;

  constructor(
    @Inject(MANAGER_CONFIG) private readonly config: ManagerConfig,
    private readonly daemon: DaemonClient,
  ) {
    super();
    for (const s of loadSpokes(config.spokesFile, config.hostName, this.logger))
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
        deadline: null,
        attempt: 0,
        presence: {},
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
      if (l.deadline) clearTimeout(l.deadline);
      l.ws?.close();
    }
  }

  hosts(): HostStatus[] {
    return [
      {
        name: this.config.hostName,
        local: true,
        connected: true,
        daemon: this.daemon.connected,
      },
      ...[...this.spokes.keys()].map((name) => {
        const l = this.links.get(name);
        return {
          name,
          local: false,
          connected: l?.connected ?? false,
          daemon: l?.daemon ?? false,
          ...(l?.error ? { error: l.error } : {}),
        };
      }),
    ];
  }

  /** The spokes' presence, ids prefixed, for the gateway to merge with its own. */
  remotePresence(): PresenceMap {
    const out: PresenceMap = {};
    for (const l of this.links.values()) Object.assign(out, l.presence);
    return out;
  }

  /** `<spoke>:<id>` → the spoke and the id it knows; null for a local id or an unknown spoke. */
  split(id: string): { spoke: Spoke; id: string } | null {
    const i = id.indexOf(SEP);
    if (i <= 0) return null;
    const spoke = this.spokes.get(id.slice(0, i));
    return spoke ? { spoke, id: id.slice(i + 1) } : null;
  }

  prefix(spoke: string, id: string): string {
    return `${spoke}${SEP}${id}`;
  }

  /**
   * A request to a spoke as the acting user; the body comes back with the
   * spoke's ids prefixed. A 401 or 403 from the spoke is the hub's
   * credential being refused, never the user's: it is reported as 502 so
   * a client does not take it for its own login expiring.
   */
  async call<T = unknown>(
    spoke: Spoke,
    method: string,
    apiPath: string,
    actingUser: string,
    body?: unknown,
    timeoutMs = SPOKE_TIMEOUT_MS,
  ): Promise<{ status: number; body: T }> {
    let res: Response;
    try {
      res = await fetch(spoke.url.replace(/\/$/, '') + apiPath, {
        method,
        headers: {
          authorization: `Bearer ${spoke.token}`,
          'x-acting-user': actingUser,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      this.noteError(spoke.name, (err as Error).message);
      throw err;
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { statusCode: res.status, message: text.slice(0, 200) };
    }
    if (res.status === 401 || res.status === 403) {
      this.noteError(spoke.name, `refused the hub's token (${res.status})`);
      return {
        status: 502,
        body: {
          statusCode: 502,
          code: 'spoke-auth',
          message: `${spoke.name} refused the hub's credentials; check its AGENT_MANAGER_HUB_TOKEN and the hub's spokes.json`,
        } as T,
      };
    }
    this.noteError(spoke.name, undefined);
    return { status: res.status, body: prefixIds(spoke.name, data) as T };
  }

  /** A request whose body is bytes (an upload), forwarded as such. */
  async callRaw<T = unknown>(
    spoke: Spoke,
    method: string,
    apiPath: string,
    actingUser: string,
    body: Buffer,
    contentType: string,
  ): Promise<{ status: number; body: T }> {
    let res: Response;
    try {
      res = await fetch(spoke.url.replace(/\/$/, '') + apiPath, {
        method,
        headers: {
          authorization: `Bearer ${spoke.token}`,
          'x-acting-user': actingUser,
          'content-type': contentType,
        },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(SPOKE_TIMEOUT_MS * 4),
      });
    } catch (err) {
      this.noteError(spoke.name, (err as Error).message);
      throw err;
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { statusCode: res.status, message: text.slice(0, 200) };
    }
    if (res.status === 401 || res.status === 403) {
      this.noteError(spoke.name, `refused the hub's token (${res.status})`);
      return {
        status: 502,
        body: {
          statusCode: 502,
          code: 'spoke-auth',
          message: `${spoke.name} refused the hub's credentials`,
        } as T,
      };
    }
    this.noteError(spoke.name, undefined);
    return { status: res.status, body: prefixIds(spoke.name, data) as T };
  }

  /** What a request to a spoke last said, shown in its host status. */
  private noteError(name: string, error: string | undefined): void {
    const l = this.links.get(name);
    if (!l || l.error === error) return;
    l.error = error;
    this.emit('hosts', this.hosts());
  }

  /**
   * The projects of every spoke that answers in time, ids prefixed and
   * `host` set; a spoke that does not answer contributes nothing, and its
   * host status carries the error.
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
          if (r.status === 200 && Array.isArray(r.body)) {
            for (const row of r.body) out.push(withHost(row, spoke.name));
          } else
            this.noteError(
              spoke.name,
              `projects not listed (${r.status}): ${String((r.body as { message?: unknown } | null)?.message ?? '')}`.trim(),
            );
        } catch (err) {
          this.noteError(
            spoke.name,
            `projects not listed: ${(err as Error).message}`,
          );
          this.logger.warn(
            `spoke ${spoke.name}: projects not listed: ${(err as Error).message}`,
          );
        }
      }),
    );
    return out;
  }

  /** The spokes' account usage, each under its host; a spoke that does not answer contributes nothing. */
  async listRemoteUsage(
    actingUser: string,
  ): Promise<{ host: string; accounts: unknown[] }[]> {
    const out: { host: string; accounts: unknown[] }[] = [];
    await Promise.all(
      [...this.spokes.values()].map(async (spoke) => {
        try {
          const r = await this.call<{ hosts?: { accounts?: unknown[] }[] }>(
            spoke,
            'GET',
            '/api/usage',
            actingUser,
            undefined,
            LIST_TIMEOUT_MS,
          );
          if (r.status === 200 && Array.isArray(r.body?.hosts))
            out.push({
              host: spoke.name,
              accounts: r.body.hosts[0]?.accounts ?? [],
            });
        } catch {
          // its host status says why
        }
      }),
    );
    return out;
  }

  private connect(spoke: Spoke): void {
    if (this.closed) return;
    const link = this.links.get(spoke.name)!;
    let ws: WebSocket;
    try {
      ws = new WebSocket(
        spoke.url.replace(/^http/, 'ws').replace(/\/$/, '') + '/api/events',
        {
          headers: {
            authorization: `Bearer ${spoke.token}`,
            'x-acting-user': 'hub',
          },
        },
      );
    } catch (err) {
      this.logger.error(`spoke ${spoke.name}: ${(err as Error).message}`);
      this.retry(spoke, link);
      return;
    }
    link.ws = ws;
    const arm = (ms: number) => {
      if (link.deadline) clearTimeout(link.deadline);
      link.deadline = setTimeout(() => ws.terminate(), ms);
      link.deadline.unref();
    };
    arm(OPEN_TIMEOUT_MS); // a server that accepts TCP and never upgrades
    ws.on('open', () => {
      link.attempt = 0;
      arm(SILENCE_TIMEOUT_MS);
    });
    ws.on('ping', () => arm(SILENCE_TIMEOUT_MS)); // the spoke pings every 25 s; silence means a dead link
    ws.on('message', (data) => {
      arm(SILENCE_TIMEOUT_MS);
      let f: Record<string, unknown>;
      try {
        f = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (f.type === 'hello') {
        const wasDown = !link.connected;
        link.connected = true;
        link.daemon = Boolean(
          (f.daemon as { connected?: boolean } | undefined)?.connected,
        );
        link.presence = f.presence
          ? (rewriteFrame(spoke.name, { type: 'presence', agents: f.presence })
              .agents as PresenceMap)
          : {};
        this.emit('hosts', this.hosts());
        this.emit('presence');
        // Whatever the spoke sent while the link was down is gone: clients
        // showing its agents must refetch, as they do after their own gap.
        if (wasDown && link.attempt >= 0) this.emit('reconnected', spoke.name);
        return;
      }
      if (!link.connected) return; // nothing before hello is trusted
      if (f.type === 'daemon') {
        link.daemon = Boolean(f.connected);
        this.emit('hosts', this.hosts());
        return;
      }
      if (f.type === 'presence') {
        link.presence = rewriteFrame(spoke.name, f).agents as PresenceMap;
        this.emit('presence');
        return;
      }
      if (
        f.type === 'users.changed' ||
        f.type === 'ui.build' ||
        f.type === 'hosts' ||
        f.type === 'host.reconnected'
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
      link.presence = {};
      if (link.deadline) clearTimeout(link.deadline);
      if (was) {
        this.emit('hosts', this.hosts());
        this.emit('presence');
      }
      this.retry(spoke, link);
    });
  }

  private retry(spoke: Spoke, link: Link): void {
    if (this.closed) return;
    const delay = Math.min(30_000, 1000 * 2 ** link.attempt++);
    link.timer = setTimeout(() => this.connect(spoke), delay);
    link.timer.unref();
  }
}

/**
 * `spokes.json`: a list of `{ name, url, token }`. Refused as a whole
 * when malformed, when a name repeats or is this machine's own, or when
 * the file is readable by other users (the tokens are credentials).
 * Errors never quote an entry, since the entry holds the token.
 */
function loadSpokes(file: string, localName: string, logger: Logger): Spoke[] {
  let raw: string;
  try {
    const st = fs.statSync(file);
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
      logger.error(
        `${file} is readable by other users; chmod 600 it (the spokes are ignored until then)`,
      );
      return [];
    }
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    logger.error(`${path.basename(file)} ignored: not valid JSON`); // never the parser's message: it quotes the text
    return [];
  }
  try {
    if (!Array.isArray(list)) throw new Error('not a list');
    const out: Spoke[] = [];
    for (const [i, s] of (list as Record<string, unknown>[]).entries()) {
      const name = String(s?.name ?? '');
      const url = String(s?.url ?? '');
      const token = String(s?.token ?? '');
      if (!NAME_RE.test(name)) throw new Error(`entry ${i + 1}: bad name`);
      if (name === localName)
        throw new Error(
          `entry ${i + 1} (${name}): a spoke cannot be named like this machine (AGENT_MANAGER_HOST_NAME)`,
        );
      if (out.some((o) => o.name === name))
        throw new Error(`entry ${i + 1} (${name}): the name repeats`);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error(`entry ${i + 1} (${name}): bad url`);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        throw new Error(`entry ${i + 1} (${name}): url must be http(s)`);
      if (!token) throw new Error(`entry ${i + 1} (${name}): no token`);
      out.push({
        name,
        url: parsed.origin + parsed.pathname.replace(/\/$/, ''),
        token,
      });
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

/** Subtrees that are content, not references: agent output, tool input, feature text. Left as they are. */
const CONTENT_KEYS = new Set([
  'item',
  'items',
  'input',
  'output',
  'body',
  'usage',
  'feature',
  'features',
]);

/**
 * Prefixes the project and agent ids in a spoke's reply so the hub's
 * clients see one id space: `id` of a project (has `repos`) or an agent
 * (has `profile` and `projectId`), `projectId` and `agentId` wherever they
 * are references, the restart endpoint's `restarted` and `skipped` ids.
 * Transcript items, tool input and feature text are never touched.
 */
export function prefixIds(host: string, v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => prefixIds(host, x));
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const isProject = 'repos' in o && typeof o.id === 'string';
  const isAgent =
    'profile' in o && 'projectId' in o && typeof o.id === 'string';
  for (const [k, val] of Object.entries(o)) {
    if (CONTENT_KEYS.has(k)) out[k] = val;
    else if (
      (k === 'projectId' ||
        k === 'agentId' ||
        (k === 'id' && (isProject || isAgent))) &&
      typeof val === 'string'
    )
      out[k] = `${host}:${val}`;
    else if (k === 'restarted' && Array.isArray(val))
      out[k] = val.map((x) => (typeof x === 'string' ? `${host}:${x}` : x));
    else if (k === 'skipped' && Array.isArray(val))
      out[k] = val.map((x) =>
        x &&
        typeof x === 'object' &&
        typeof (x as { id?: unknown }).id === 'string'
          ? { ...(x as object), id: `${host}:${(x as { id: string }).id}` }
          : x,
      );
    else out[k] = prefixIds(host, val);
  }
  if (isProject) out.host = host;
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
