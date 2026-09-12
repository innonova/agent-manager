import { Module } from '@nestjs/common';
import { ChangesController } from './changes.controller.js';
import { ChangesService } from './changes.service.js';

@Module({ controllers: [ChangesController], providers: [ChangesService] })
export class ChangesModule {}
