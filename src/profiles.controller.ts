import { Controller, Get } from '@nestjs/common';
import { AdaptersService } from './adapters/adapters.service.js';
import { DaemonClient, DaemonProfile } from './daemon/daemon-client.js';

@Controller('api/profiles')
export class ProfilesController {
  constructor(
    private readonly daemon: DaemonClient,
    private readonly adapters: AdaptersService,
  ) {}

  /** Daemon profiles, marked with whether this manager can drive them. */
  @Get()
  async list(): Promise<{
    profiles: (DaemonProfile & { supported: boolean })[];
  }> {
    const profiles = await this.daemon.listProfiles();
    return {
      profiles: profiles.map((p) => ({
        ...p,
        supported: this.adapters.supports(p.name),
      })),
    };
  }
}
