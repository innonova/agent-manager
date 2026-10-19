import { Inject, Logger } from '@nestjs/common';
import { WebSocketGateway } from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import WebSocket from 'ws';
import { AuthService } from '../auth/auth.service.js';
import { MANAGER_CONFIG } from '../config/config.js';
import type { ManagerConfig } from '../config/config.js';

/**
 * A hub's way to this machine's daemon: a socket on `/api/daemon`, opened
 * with the hub token, piped frame for frame to the local daemon. The
 * daemon itself stays the unauthenticated local component it is; this is
 * the one door in, and the token is the same the hub uses for every other
 * call here. Nothing is parsed: the hub's own daemon client speaks the
 * daemon's protocol end to end.
 */
@WebSocketGateway({ path: '/api/daemon' })
export class DaemonTunnelGateway {
  private readonly logger = new Logger(DaemonTunnelGateway.name);

  constructor(
    @Inject(MANAGER_CONFIG) private readonly config: ManagerConfig,
    private readonly auth: AuthService,
  ) {}

  handleConnection(client: WebSocket, req: IncomingMessage): void {
    const { user, scope } = this.auth.userForHeaders(req.headers);
    const token = String(req.headers.authorization ?? '');
    // only the hub token: a login session or an agent token is not a daemon's peer
    if (
      !user ||
      scope ||
      !token.startsWith('Bearer ') ||
      !this.config.hubToken
    ) {
      client.close(4401, 'unauthorized');
      return;
    }
    const daemon = new WebSocket(this.config.daemonUrl);
    const queued: string[] = [];
    client.on('message', (data) => {
      const text = String(data);
      if (daemon.readyState === WebSocket.OPEN) daemon.send(text);
      else queued.push(text); // sent once the daemon side is up
    });
    daemon.on('open', () => {
      for (const t of queued) daemon.send(t);
      queued.length = 0;
    });
    daemon.on('message', (data) => {
      if (client.readyState === WebSocket.OPEN) client.send(String(data));
    });
    const closeBoth = (why: string) => {
      if (client.readyState === WebSocket.OPEN) client.close(1011, why);
      if (
        daemon.readyState === WebSocket.OPEN ||
        daemon.readyState === WebSocket.CONNECTING
      )
        daemon.close();
    };
    daemon.on('close', () => closeBoth('daemon closed'));
    daemon.on('error', (err) => {
      this.logger.warn(`tunnel: daemon socket error: ${err.message}`);
      closeBoth('daemon error');
    });
    client.on('close', () => closeBoth('hub closed'));
    client.on('error', () => closeBoth('hub error'));
    this.logger.log(`tunnel opened for ${user.name}`);
  }
}
