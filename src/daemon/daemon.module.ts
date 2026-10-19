import { Global, Module } from '@nestjs/common';
import { DaemonClients } from './daemon-clients.js';
import { DaemonTunnelGateway } from './daemon-tunnel.gateway.js';

@Global()
@Module({
  providers: [DaemonClients, DaemonTunnelGateway],
  exports: [DaemonClients],
})
export class DaemonModule {}
