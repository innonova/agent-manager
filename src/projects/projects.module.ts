import { Global, Module } from '@nestjs/common';
import { ProjectsService } from './projects.service.js';

@Global()
@Module({ providers: [ProjectsService], exports: [ProjectsService] })
export class ProjectsModule {}
