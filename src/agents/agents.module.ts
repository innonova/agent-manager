import { Global, Module } from '@nestjs/common';
import { ProjectsController } from '../projects/projects.controller.js';
import { AgentsController } from './agents.controller.js';
import { AgentsService } from './agents.service.js';
import { HarnessController } from './harness.controller.js';

@Global()
@Module({
  controllers: [AgentsController, ProjectsController, HarnessController],
  providers: [AgentsService],
  exports: [AgentsService],
})
export class AgentsModule {}
