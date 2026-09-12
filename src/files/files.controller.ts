import { Controller, Get, Param, Query } from '@nestjs/common';
import { DirEntry, FileContent, FilesService } from './files.service.js';

@Controller('api/projects/:id')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Get('files')
  list(
    @Param('id') id: string,
    @Query('path') p?: string,
  ): Promise<{ path: string; entries: DirEntry[] }> {
    return this.files.list(id, p ?? '');
  }

  @Get('file')
  read(
    @Param('id') id: string,
    @Query('path') p?: string,
  ): Promise<FileContent> {
    return this.files.read(id, p ?? '');
  }
}
