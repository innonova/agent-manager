import { DynamicModule } from '@nestjs/common';
import { ManagerConfig } from './config.js';
export declare class ConfigModule {
    static forRoot(overrides?: Partial<ManagerConfig>): DynamicModule;
}
