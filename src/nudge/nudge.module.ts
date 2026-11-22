import { Module } from '@nestjs/common';
import { StatsModule } from '../stats/stats.module.js';
import { NudgeController } from './nudge.controller.js';
import { NudgeService } from './nudge.service.js';

@Module({
  imports: [StatsModule],
  controllers: [NudgeController],
  providers: [NudgeService],
})
export class NudgeModule {}
