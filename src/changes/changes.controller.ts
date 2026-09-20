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

/**
 * The project's commit list and per-commit diffs. A second controller
 * rather than more verbs on the changes one, so its base path is
 * `/api/projects/:id/commits`; the hub proxy forwards it to a spoke by the
 * project id like every `/api/projects/:id/...` route, and the `:repo` and
 * `:hash` segments pass its safe-segment check.
 */
@Controller('api/projects/:id/commits')
export class CommitsController {
  constructor(private readonly changes: ChangesService) {}

  @Get()
  list(
    @Req() req: Req,
    @Param('id') id: string,
    @Query('repo') repo?: string,
    @Query('feature') feature?: string,
    @Query('agent') agent?: string,
    @Query('since') since?: string,
    @Query('limit') limit?: string,
    @Query('count') count?: string,
  ) {
    if (count)
      return this.changes
        .commitCount(req.user!.id, id)
        .then((sinceCount) => ({ commits: [], working: [], sinceCount }));
    return this.changes.commits(req.user!.id, id, {
      repo,
      feature,
      agent,
      since,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get(':repo/:hash')
  commit(
    @Req() req: Req,
    @Param('id') id: string,
    @Param('repo') repo: string,
    @Param('hash') hash: string,
    @Query('path') p?: string,
  ) {
    return this.changes.commit(req.user!.id, id, repo, hash, p);
  }
}
