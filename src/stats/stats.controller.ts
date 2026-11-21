import { Controller, Get, Param } from '@nestjs/common';
import type { Stats } from './stats.js';
import { StatsService } from './stats.service.js';

@Controller('api')
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  /** How the agent has been run: its runtime, tokens and cost, the work since a person last wrote, and how much of it went on with nobody near. */
  @Get('agents/:id/stats')
  one(@Param('id') id: string): Promise<Stats> {
    return this.stats.stats(id);
  }
}
