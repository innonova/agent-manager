import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/auth.guard.js';
import { DaemonClient } from './daemon/daemon-client.js';

@Controller('api/health')
export class HealthController {
  constructor(private readonly daemon: DaemonClient) {}

  /** Liveness for service managers and test harnesses; says whether the daemon is reachable. */
  @Public()
  @Get()
  health(): { status: 'ok'; daemon: boolean } {
    return { status: 'ok', daemon: this.daemon.connected };
  }
}
