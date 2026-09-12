import { DynamicModule, Global, Module } from '@nestjs/common';
import { MANAGER_CONFIG, ManagerConfig, loadConfig } from './config.js';

@Global()
@Module({})
export class ConfigModule {
  static forRoot(overrides: Partial<ManagerConfig> = {}): DynamicModule {
    const config: ManagerConfig = { ...loadConfig(), ...overrides };
    return {
      module: ConfigModule,
      providers: [{ provide: MANAGER_CONFIG, useValue: config }],
      exports: [MANAGER_CONFIG],
    };
  }
}
