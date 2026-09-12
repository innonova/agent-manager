import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { User } from '../auth/auth.service.js';
import { ChangesService } from './changes.service.js';

type Req = Request & { user?: User };

@Controller('api/projects/:id/changes')
export class ChangesController {
  constructor(private readonly changes: ChangesService) {}

  @Get()
  list(@Req() req: Req, @Param('id') id: string, @Query('base') base?: string) {
    return this.changes.list(req.user!.id, id, base || 'read');
  }

  @Get('file')
  file(
    @Req() req: Req,
    @Param('id') id: string,
    @Query('path') p?: string,
    @Query('base') base?: string,
  ) {
    return this.changes.file(req.user!.id, id, p, base || 'read');
  }

  @Post('read')
  read(
    @Req() req: Req,
    @Param('id') id: string,
    @Body() body?: { repo?: unknown },
  ) {
    return this.changes.markRead(req.user!.id, id, body?.repo);
  }
}
