import { Controller, Get, Param } from '@nestjs/common';
import { AdaptersService } from './adapters/adapters.service.js';
import { DaemonClient, DaemonProfile } from './daemon/daemon-client.js';

@Controller()
export class ProfilesController {
  constructor(
    private readonly daemon: DaemonClient,
    private readonly adapters: AdaptersService,
  ) {}

  /** The profiles a project's agents can use: this machine's daemon profiles (a spoke's project is proxied to the spoke). */
  @Get('/api/projects/:id/profiles')
  forProject(@Param('id') _id: string) {
    void _id;
    return this.list();
  }

  /** Daemon profiles, marked with whether this manager can drive them. */
  @Get('/api/profiles')
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
