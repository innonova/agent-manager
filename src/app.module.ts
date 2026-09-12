import { DynamicModule, Module } from '@nestjs/common';
import { AdaptersModule } from './adapters/adapters.module.js';
import { AgentsModule } from './agents/agents.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ConfigModule } from './config/config.module.js';
import { ManagerConfig } from './config/config.js';
import { DaemonModule } from './daemon/daemon.module.js';
import { DbModule } from './db/db.module.js';
import { EventsModule } from './events/events.module.js';
import { FeaturesModule } from './features/features.module.js';
import { FilesModule } from './files/files.module.js';
import { HealthController } from './health.controller.js';
import { ProfilesController } from './profiles.controller.js';
import { ProjectsModule } from './projects/projects.module.js';

@Module({})
export class AppModule {
  static forRoot(overrides: Partial<ManagerConfig> = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(overrides),
        DbModule,
        AuthModule,
        DaemonModule,
        AdaptersModule,
        ProjectsModule,
        AgentsModule,
        EventsModule,
        FilesModule,
        FeaturesModule,
      ],
      controllers: [ProfilesController, HealthController],
    };
  }
}
