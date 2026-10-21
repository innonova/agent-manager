import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { Notes, NotesService } from './notes.service.js';

/** A project's notes; a hub forwards the route for a spoke's project like every `/api/projects/:id/...` one. */
@Controller('api/projects/:id/notes')
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Get()
  read(@Param('id') id: string): Promise<Notes> {
    return this.notes.read(id);
  }

  /** Adds a note: the first line of `text` is its title, the rest its body. */
  @Post()
  add(
    @Param('id') id: string,
    @Body() body: { text?: unknown },
  ): Promise<Notes> {
    return this.notes.add(id, body?.text);
  }

  @Patch(':noteId')
  update(
    @Param('id') id: string,
    @Param('noteId') noteId: string,
    @Body() body: { done?: unknown; text?: unknown },
  ): Promise<Notes> {
    return this.notes.update(id, noteId, body ?? {});
  }

  @Delete(':noteId')
  remove(
    @Param('id') id: string,
    @Param('noteId') noteId: string,
  ): Promise<Notes> {
    return this.notes.remove(id, noteId);
  }
}
