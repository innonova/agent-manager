import { Global, Module } from '@nestjs/common';
import { PushController } from './push.controller.js';
import { PushService } from './push.service.js';

@Global()
@Module({
  controllers: [PushController],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
