import { Module } from '@nestjs/common';
import { StreamsModule } from '../streams/streams.module.js';
import { EventsGateway } from './events.gateway.js';

@Module({ imports: [StreamsModule], providers: [EventsGateway] })
export class EventsModule {}
