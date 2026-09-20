import { Global, Module } from '@nestjs/common';
import { RunsController } from './runs.controller.js';
import { RunsService } from './runs.service.js';

// Global like the agents and features modules, for the same reason: the
// events gateway listens to all three.
@Global()
@Module({
  controllers: [RunsController],
  providers: [RunsService],
  exports: [RunsService],
})
export class RunsModule {}
