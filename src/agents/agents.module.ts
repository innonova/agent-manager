import { Global, Module } from '@nestjs/common';
import { ProjectsController } from '../projects/projects.controller.js';
import { AgentsController } from './agents.controller.js';
import { AgentsService } from './agents.service.js';

@Global()
@Module({
  controllers: [AgentsController, ProjectsController],
  providers: [AgentsService],
  exports: [AgentsService],
})
export class AgentsModule {}
