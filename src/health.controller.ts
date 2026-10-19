import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/auth.guard.js';
import { DaemonClients } from './daemon/daemon-clients.js';
import { HostStatus, HubService } from './hub/hub.service.js';

@Controller('api/health')
export class HealthController {
  constructor(
    private readonly daemons: DaemonClients,
    private readonly hub: HubService,
  ) {}

  /** Liveness for service managers and test harnesses; says whether the daemon is reachable, and (as a hub) the spokes. */
  @Public()
  @Get()
  health(): { status: 'ok'; daemon: boolean; hosts: HostStatus[] } {
    return {
      status: 'ok',
      daemon: this.daemons.local.connected,
      hosts: this.hub.hosts(),
    };
  }
}
