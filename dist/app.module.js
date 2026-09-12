var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var AppModule_1;
import { Module } from '@nestjs/common';
import { AdaptersModule } from './adapters/adapters.module.js';
import { AgentsModule } from './agents/agents.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ConfigModule } from './config/config.module.js';
import { DaemonModule } from './daemon/daemon.module.js';
import { DbModule } from './db/db.module.js';
import { EventsModule } from './events/events.module.js';
import { FilesModule } from './files/files.module.js';
import { HealthController } from './health.controller.js';
import { ProfilesController } from './profiles.controller.js';
import { ProjectsModule } from './projects/projects.module.js';
let AppModule = AppModule_1 = class AppModule {
    static forRoot(overrides = {}) {
        return {
            module: AppModule_1,
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
            ],
            controllers: [ProfilesController, HealthController],
        };
    }
};
AppModule = AppModule_1 = __decorate([
    Module({})
], AppModule);
export { AppModule };
//# sourceMappingURL=app.module.js.map