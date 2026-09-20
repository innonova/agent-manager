import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { User } from '../auth/auth.service.js';
import { NoteFileService, type NoteFileRow } from './note-files.js';

/**
 * The harness note's template, per machine: what every agent is told at
 * session start. Read and written through the UI so the file in
 * `~/.config` needs no shell; a hub forwards to its spokes by host name,
 * since each machine has its own file.
 */
@Controller('api/harness')
export class HarnessController {
  constructor(private readonly notes: NoteFileService) {}

  @Get()
  list(
    @Req() req: Request & { user?: User },
  ): Promise<{ hosts: NoteFileRow[] }> {
    return this.notes.list('harness', req.user?.name ?? 'hub');
  }

  @Put()
  save(
    @Req() req: Request & { user?: User },
    @Body() body: { host?: unknown; template?: unknown },
  ): Promise<NoteFileRow> {
    return this.notes.save('harness', req.user?.name ?? 'hub', body);
  }
}

/**
 * The house view of the models, per machine, on the same terms as the
 * harness template: `models.md` beside `harness.md`, edited in the UI with
 * the same editor, and rendered into every note at `{{models}}`. An agent
 * reads it in its note and nowhere else — the route is a human's.
 */
@Controller('api/models')
export class ModelsController {
  constructor(private readonly notes: NoteFileService) {}

  @Get()
  list(
    @Req() req: Request & { user?: User },
  ): Promise<{ hosts: NoteFileRow[] }> {
    return this.notes.list('models', req.user?.name ?? 'hub');
  }

  @Put()
  save(
    @Req() req: Request & { user?: User },
    @Body() body: { host?: unknown; template?: unknown },
  ): Promise<NoteFileRow> {
    return this.notes.save('models', req.user?.name ?? 'hub', body);
  }
}
