import { Global, Module } from '@nestjs/common';
import { FeaturesController } from './features.controller.js';
import { FeaturesService } from './features.service.js';

@Global()
@Module({
  controllers: [FeaturesController],
  providers: [FeaturesService],
  exports: [FeaturesService],
})
export class FeaturesModule {}
