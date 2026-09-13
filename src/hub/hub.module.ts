import { Global, Module } from '@nestjs/common';
import { HubService } from './hub.service.js';

@Global()
@Module({ providers: [HubService], exports: [HubService] })
export class HubModule {}
