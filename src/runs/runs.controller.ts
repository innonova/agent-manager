import {
  Controller,
  Get,
  HttpException,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { User } from '../auth/auth.service.js';
import { HubService } from '../hub/hub.service.js';
import { RunsService, type Run } from './runs.service.js';
import type { StoredItem } from '../agents/agents.service.js';

/**
 * The run log: what each agent did on each feature, with what it cost and
 * what it said about it. Read-only — a run is recorded by watching, never
 * by being told — and a human's, like the harness and models files: an
 * agent's token is refused these routes.
 *
 * A hub reaches a spoke's runs through the project filter (`project` is
 * `<spoke>:<id>` there) and a run id it already has from such a listing,
 * which comes back prefixed the same way. An unfiltered listing is this
 * machine's own.
 */
@Controller('api/runs')
export class RunsController {
  constructor(
    private readonly runs: RunsService,
    private readonly hub: HubService,
  ) {}

  @Get()
  async list(
    @Req() req: Request & { user?: User },
    @Query('project') project?: string,
    @Query('feature') feature?: string,
    @Query('model') model?: string,
    @Query('since') since?: string,
    @Query('limit') limit?: string,
  ): Promise<{ runs: Run[] }> {
    const remote = project ? this.hub.split(project) : null;
    if (remote) {
      const query = new URLSearchParams({ project: remote.id });
      if (feature) query.set('feature', feature);
      if (model) query.set('model', model);
      if (since) query.set('since', since);
      if (limit) query.set('limit', limit);
      const r = await this.hub.call<{ runs?: Run[] }>(
        remote.spoke,
        'GET',
        `/api/runs?${query}`,
        req.user?.name ?? 'hub',
      );
      if (r.status >= 400)
        throw new HttpException(
          r.body ?? { statusCode: r.status, message: 'spoke refused' },
          r.status,
        );
      return {
        runs: (r.body?.runs ?? []).map((run) => prefix(run, remote.spoke.name)),
      };
    }
    return {
      runs: this.runs.list({
        projectId: project,
        slug: feature,
        model,
        since: since === undefined ? undefined : Number(since),
        limit: limit === undefined ? undefined : Number(limit),
      }),
    };
  }

  @Get(':id')
  async one(
    @Req() req: Request & { user?: User },
    @Param('id') id: string,
  ): Promise<{ run: Run; transcript: StoredItem[] }> {
    const remote = this.hub.split(id);
    if (remote) {
      const r = await this.hub.call<{ run: Run; transcript: StoredItem[] }>(
        remote.spoke,
        'GET',
        `/api/runs/${encodeURIComponent(remote.id)}`,
        req.user?.name ?? 'hub',
      );
      if (r.status >= 400)
        throw new HttpException(
          r.body ?? { statusCode: r.status, message: 'spoke refused' },
          r.status,
        );
      return { ...r.body, run: prefix(r.body.run, remote.spoke.name) };
    }
    const run = this.runs.get(id);
    if (!run)
      throw new HttpException(
        { statusCode: 404, message: `no run ${id}` },
        404,
      );
    return { run, transcript: await this.runs.transcript(id) };
  }
}

/** A spoke's ids, as everywhere else in a hub's answers: `<spoke>:<id>`. */
function prefix(run: Run, spoke: string): Run {
  return {
    ...run,
    id: `${spoke}:${run.id}`,
    projectId: `${spoke}:${run.projectId}`,
    agentId: `${spoke}:${run.agentId}`,
  };
}
