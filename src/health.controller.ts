import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/auth.guard.js';
import { DaemonClient } from './daemon/daemon-client.js';
import { HostStatus, HubService } from './hub/hub.service.js';

@Controller('api/health')
export class HealthController {
  constructor(
    private readonly daemon: DaemonClient,
    private readonly hub: HubService,
  ) {}

  /** Liveness for service managers and test harnesses; says whether the daemon is reachable, and (as a hub) the spokes. */
  @Public()
  @Get()
  health(): { status: 'ok'; daemon: boolean; hosts: HostStatus[] } {
    return {
      status: 'ok',
      daemon: this.daemon.connected,
      hosts: this.hub.hosts(),
    };
  }
}
