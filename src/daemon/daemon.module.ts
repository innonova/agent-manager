import { Global, Module } from '@nestjs/common';
import { DaemonClient } from './daemon-client.js';

@Global()
@Module({ providers: [DaemonClient], exports: [DaemonClient] })
export class DaemonModule {}
