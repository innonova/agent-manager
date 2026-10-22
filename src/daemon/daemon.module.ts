import { Global, Module } from '@nestjs/common';
import { DaemonClients } from './daemon-clients.js';
import { DaemonTunnelGateway } from './daemon-tunnel.gateway.js';
import { ExecController } from './exec.controller.js';
import { ExecService } from './exec.service.js';

@Global()
@Module({
  controllers: [ExecController],
  providers: [DaemonClients, DaemonTunnelGateway, ExecService],
  exports: [DaemonClients, ExecService],
})
export class DaemonModule {}
