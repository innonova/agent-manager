import { Global, Module } from '@nestjs/common';
import { AdaptersService } from './adapters.service.js';

@Global()
@Module({ providers: [AdaptersService], exports: [AdaptersService] })
export class AdaptersModule {}
