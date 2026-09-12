import type { NestExpressApplication } from '@nestjs/platform-express';
import { ManagerConfig } from './config/config.js';
export declare function createApp(overrides?: Partial<ManagerConfig>, options?: {
    quiet?: boolean;
}): Promise<NestExpressApplication>;
