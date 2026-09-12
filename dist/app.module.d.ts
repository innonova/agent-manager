import { DynamicModule } from '@nestjs/common';
import { ManagerConfig } from './config/config.js';
export declare class AppModule {
    static forRoot(overrides?: Partial<ManagerConfig>): DynamicModule;
}
