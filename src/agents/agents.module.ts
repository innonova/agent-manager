import { Global, Module } from '@nestjs/common';
import { ProjectsController } from '../projects/projects.controller.js';
import { AgentsController } from './agents.controller.js';
import { AgentsService } from './agents.service.js';
import {
  HarnessController,
  ModelsController,
} from './note-files.controller.js';
import { NoteFileService } from './note-files.js';

@Global()
@Module({
  controllers: [
    AgentsController,
    ProjectsController,
    HarnessController,
    ModelsController,
  ],
  providers: [AgentsService, NoteFileService],
  exports: [AgentsService],
})
export class AgentsModule {}
