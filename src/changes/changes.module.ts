import { Global, Module } from '@nestjs/common';
import {
  ChangesController,
  CommitsController,
} from './changes.controller.js';
import { ChangesService } from './changes.service.js';
import { ReadCursorsService } from './read-cursors.service.js';

@Global()
@Module({
  controllers: [ChangesController, CommitsController],
  providers: [ChangesService, ReadCursorsService],
  exports: [ReadCursorsService],
})
export class ChangesModule {}
