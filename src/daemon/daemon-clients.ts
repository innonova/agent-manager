import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { MANAGER_CONFIG } from '../config/config.js';
import type { ManagerConfig } from '../config/config.js';
import { loadSpokes } from '../hub/spokes.js';
import { DaemonClient } from './daemon-client.js';
import type { DaemonSession, LogRecord } from './daemon-client.js';

interface DaemonsEvents {
  connected: [host: string];
  disconnected: [host: string];
  output: [host: string, id: string, record: LogRecord];
  changed: [host: string, session: DaemonSession];
}

/**
 * The daemons this manager drives: its own, and on a hub one per spoke,
 * reached through the tunnel the spoke's manager offers at `/api/daemon`
 * with the hub token. An agent's sessions live on the daemon of its
 * host; the agents service asks here for the client by host. The
 * clients' events are re-emitted with the host in front.
 */
@Injectable()
export class DaemonClients
  extends EventEmitter<DaemonsEvents>
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(DaemonClients.name);
  readonly local: DaemonClient;
  private readonly remote = new Map<string, DaemonClient>();
  /** The spokes as configured, for what the note says about other machines. */
  private readonly spokes: { name: string; description?: string }[] = [];

  constructor(@Inject(MANAGER_CONFIG) private readonly config: ManagerConfig) {
    super();
    this.local = new DaemonClient(config.hostName, config.daemonUrl);
    for (const s of loadSpokes(
      config.spokesFile,
      config.hostName,
      this.logger,
    )) {
      this.spokes.push({ name: s.name, description: s.description });
      const url = `${s.url.replace(/^http/, 'ws')}/api/daemon`;
      this.remote.set(
        s.name,
        new DaemonClient(s.name, url, {
          authorization: `Bearer ${s.token}`,
          'x-acting-user': 'hub',
        }),
      );
    }
  }

  /** The local client for null or this machine's name; a spoke's for its name; undefined for a host not configured. */
  for(host: string | null | undefined): DaemonClient | undefined {
    if (!host || host === this.config.hostName) return this.local;
    return this.remote.get(host);
  }

  /** Every host that has a daemon here: this machine first. */
  hosts(): string[] {
    return [this.config.hostName, ...this.remote.keys()];
  }

  /** The other machines an agent of a project here can run on, with what each is for and whether its daemon is reachable now. */
  remoteHosts(): { name: string; description?: string; connected: boolean }[] {
    return this.spokes.map((s) => ({
      ...s,
      connected: this.remote.get(s.name)?.connected ?? false,
    }));
  }

  all(): DaemonClient[] {
    return [this.local, ...this.remote.values()];
  }

  onModuleInit(): void {
    for (const c of this.all()) {
      c.on('connected', () => this.emit('connected', c.host));
      c.on('disconnected', () => this.emit('disconnected', c.host));
      c.on('output', (id, record) => this.emit('output', c.host, id, record));
      c.on('changed', (session) => this.emit('changed', c.host, session));
      c.open();
    }
  }

  onModuleDestroy(): void {
    for (const c of this.all()) c.close();
    this.removeAllListeners();
  }
}
