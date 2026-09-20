import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Put,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { User } from '../auth/auth.service.js';
import { MANAGER_CONFIG, type ManagerConfig } from '../config/config.js';
import { HubService } from '../hub/hub.service.js';
import { DEFAULT_HARNESS_NOTE } from './harness.js';

/** The template's state on one machine: built in, the operator's, or turned off (an empty file). */
export interface HarnessRow {
  host: string;
  source: 'built-in' | 'custom' | 'off';
  /** The template in force (the built-in one when there is no file). */
  template: string;
  builtIn: string;
  file: string;
}

const MAX_TEMPLATE_BYTES = 64 * 1024;

/**
 * The harness note's template, per machine: what every agent is told at
 * session start. Read and written through the UI so the file in
 * `~/.config` needs no shell; a hub forwards to its spokes by host name,
 * since each machine has its own file.
 */
@Controller('api/harness')
export class HarnessController {
  constructor(
    @Inject(MANAGER_CONFIG) private readonly config: ManagerConfig,
    private readonly hub: HubService,
  ) {}

  @Get()
  async list(
    @Req() req: Request & { user?: User },
  ): Promise<{ hosts: HarnessRow[] }> {
    const hosts = [await this.local()];
    if (this.hub.enabled) {
      const user = req.user?.name ?? 'hub';
      await Promise.all(
        [...this.hub.spokes.values()].map(async (spoke) => {
          try {
            const r = await this.hub.call<{ hosts?: HarnessRow[] }>(
              spoke,
              'GET',
              '/api/harness',
              user,
            );
            const row = r.status === 200 ? r.body?.hosts?.[0] : undefined;
            if (row) hosts.push({ ...row, host: spoke.name });
          } catch {
            // its host status says why
          }
        }),
      );
    }
    return { hosts };
  }

  /** `template`: text writes the file (empty turns the note off); null removes it, back to the built-in one. */
  @Put()
  async save(
    @Req() req: Request & { user?: User },
    @Body() body: { host?: unknown; template?: unknown },
  ): Promise<HarnessRow> {
    const { host, template } = body ?? {};
    if (template !== null && typeof template !== 'string')
      throw new BadRequestException('"template" must be a string or null');
    if (
      typeof template === 'string' &&
      Buffer.byteLength(template) > MAX_TEMPLATE_BYTES
    )
      throw new BadRequestException(
        `"template" is over ${MAX_TEMPLATE_BYTES} bytes`,
      );
    if (typeof host === 'string' && host !== this.config.hostName) {
      const spoke = this.hub.spokes.get(host);
      if (!spoke)
        throw new HttpException(
          { statusCode: 404, message: `no host ${host}` },
          404,
        );
      const r = await this.hub.call<HarnessRow>(
        spoke,
        'PUT',
        '/api/harness',
        req.user?.name ?? 'hub',
        { template },
      );
      if (r.status >= 400)
        throw new HttpException(
          r.body ?? { statusCode: r.status, message: 'spoke refused' },
          r.status,
        );
      return { ...r.body, host: spoke.name };
    }
    const file = this.config.harnessFile;
    if (template === null) await fs.rm(file, { force: true });
    else {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, template, { mode: 0o644 });
      await fs.rename(tmp, file);
    }
    return this.local();
  }

  private async local(): Promise<HarnessRow> {
    const file = this.config.harnessFile;
    let custom: string | null = null;
    try {
      custom = await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return {
      host: this.config.hostName,
      source:
        custom === null ? 'built-in' : custom.trim() === '' ? 'off' : 'custom',
      template: custom ?? DEFAULT_HARNESS_NOTE,
      builtIn: DEFAULT_HARNESS_NOTE,
      file,
    };
  }
}
