import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { User } from '../auth/auth.service.js';
import { MANAGER_CONFIG, type ManagerConfig } from '../config/config.js';
import { HubService } from '../hub/hub.service.js';
import { LearningsService } from './learnings.service.js';
import type { LearningEntry } from './learnings-file.js';

/**
 * The learnings log of this install, and of a spoke's when `host` names
 * one. Readable and writable by an agent's token as well as a person's:
 * a helper in the middle of the work is the usual author, and this is
 * the one agent-token route with no project in it, because what is
 * learned about working here is not a property of a project.
 */
@Controller('api/learnings')
export class LearningsController {
  constructor(
    private readonly learnings: LearningsService,
    private readonly hub: HubService,
    @Inject(MANAGER_CONFIG) private readonly config: ManagerConfig,
  ) {}

  @Get()
  async list(
    @Req() req: Request & { user?: User },
    @Query('since') since?: string,
    @Query('host') host?: string,
  ): Promise<{ host: string; entries: LearningEntry[] }> {
    const spoke = this.remote(host);
    if (spoke) {
      const query = since ? `?since=${encodeURIComponent(since)}` : '';
      const r = await this.hub.call<{ entries?: LearningEntry[] }>(
        spoke,
        'GET',
        `/api/learnings${query}`,
        req.user?.name ?? 'hub',
      );
      if (r.status >= 400) throw refused(r);
      return { host: spoke.name, entries: r.body?.entries ?? [] };
    }
    return {
      host: this.config.hostName,
      entries: await this.learnings.list(Number(since) || 0),
    };
  }

  @Post()
  async add(
    @Req() req: Request & { user?: User },
    @Body() body: { text?: unknown; ref?: unknown; host?: unknown },
  ): Promise<{ host: string; entry: LearningEntry }> {
    const by = req.user?.name ?? 'hub';
    const spoke = this.remote(
      typeof body?.host === 'string' ? body.host : undefined,
    );
    if (spoke) {
      const r = await this.hub.call<{ entry: LearningEntry }>(
        spoke,
        'POST',
        '/api/learnings',
        by,
        { text: body?.text, ref: body?.ref },
      );
      if (r.status >= 400) throw refused(r);
      return { host: spoke.name, entry: r.body.entry };
    }
    return {
      host: this.config.hostName,
      entry: await this.learnings.append({
        text: body?.text,
        ref: body?.ref,
        by,
      }),
    };
  }

  /** The spoke a `host` names, or null for this machine's own log. */
  private remote(host?: string) {
    if (!host || host === this.config.hostName) return null;
    const spoke = this.hub.spokes.get(host);
    if (!spoke)
      throw new HttpException(
        { statusCode: 404, message: `no host ${host}` },
        404,
      );
    return spoke;
  }
}

function refused(r: { status: number; body?: unknown }): HttpException {
  return new HttpException(
    r.body ?? { statusCode: r.status, message: 'spoke refused' },
    r.status,
  );
}
