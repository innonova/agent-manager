import { Global, Module } from '@nestjs/common';
import { ChangesController } from './changes.controller.js';
import { ChangesService } from './changes.service.js';
import { ReadCursorsService } from './read-cursors.service.js';

@Global()
@Module({
  controllers: [ChangesController],
  providers: [ChangesService, ReadCursorsService],
  exports: [ReadCursorsService],
})
export class ChangesModule {}
