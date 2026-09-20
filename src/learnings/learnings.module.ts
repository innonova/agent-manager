import { Module } from '@nestjs/common';
import { LearningsController } from './learnings.controller.js';
import { LearningsService } from './learnings.service.js';

@Module({
  controllers: [LearningsController],
  providers: [LearningsService],
  exports: [LearningsService],
})
export class LearningsModule {}
