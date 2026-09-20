import { DynamicModule, Module } from '@nestjs/common';
import { AdaptersModule } from './adapters/adapters.module.js';
import { AgentsModule } from './agents/agents.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ChangesModule } from './changes/changes.module.js';
import { ConfigModule } from './config/config.module.js';
import { ManagerConfig } from './config/config.js';
import { DaemonModule } from './daemon/daemon.module.js';
import { DbModule } from './db/db.module.js';
import { EventsModule } from './events/events.module.js';
import { FeaturesModule } from './features/features.module.js';
import { FilesModule } from './files/files.module.js';
import { HealthController } from './health.controller.js';
import { HubModule } from './hub/hub.module.js';
import { LearningsModule } from './learnings/learnings.module.js';
import { ProfilesController } from './profiles.controller.js';
import { ProjectsModule } from './projects/projects.module.js';
import { RunsModule } from './runs/runs.module.js';

@Module({})
export class AppModule {
  static forRoot(overrides: Partial<ManagerConfig> = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(overrides),
        DbModule,
        AuthModule,
        HubModule,
        DaemonModule,
        AdaptersModule,
        ProjectsModule,
        AgentsModule,
        EventsModule,
        FilesModule,
        FeaturesModule,
        ChangesModule,
        RunsModule,
        LearningsModule,
      ],
      controllers: [ProfilesController, HealthController],
    };
  }
}
