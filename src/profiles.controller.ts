import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { AdaptersService } from './adapters/adapters.service.js';
import type { DaemonProfile } from './daemon/daemon-client.js';
import { DaemonClients } from './daemon/daemon-clients.js';

@Controller()
export class ProfilesController {
  constructor(
    private readonly daemons: DaemonClients,
    private readonly adapters: AdaptersService,
  ) {}

  /** The profiles a project's agents can use: this machine's daemon profiles (a spoke's project is proxied to the spoke). */
  @Get('/api/projects/:id/profiles')
  forProject(@Param('id') _id: string) {
    void _id;
    return this.list();
  }

  /** Daemon profiles, marked with whether this manager can drive them; `host` names a spoke to ask instead of this machine. */
  @Get('/api/profiles')
  async list(@Query('host') host?: string): Promise<{
    profiles: (DaemonProfile & { supported: boolean })[];
  }> {
    const daemon = this.daemons.for(host || null);
    if (!daemon) throw new NotFoundException(`no host ${host}`);
    const profiles = await daemon.listProfiles();
    return {
      profiles: profiles.map((p) => ({
        ...p,
        supported: this.adapters.supports(p.name),
      })),
    };
  }
}
