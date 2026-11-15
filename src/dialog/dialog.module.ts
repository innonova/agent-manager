import { Module } from '@nestjs/common';
import { DialogController } from './dialog.controller.js';
import { DialogService } from './dialog.service.js';

@Module({
  controllers: [DialogController],
  providers: [DialogService],
  exports: [DialogService],
})
export class DialogModule {}
