import { Module } from '@nestjs/common';
import { DialogModule } from '../dialog/dialog.module.js';
import { ArchiveService } from './archive.service.js';
import { StreamsController } from './streams.controller.js';
import { StreamsService } from './streams.service.js';

@Module({
  imports: [DialogModule],
  controllers: [StreamsController],
  providers: [StreamsService, ArchiveService],
  exports: [StreamsService, ArchiveService],
})
export class StreamsModule {}
