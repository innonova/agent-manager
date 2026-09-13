import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
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

  /** Uploads a file: the raw body goes to `path` inside a repository; `overwrite=1` replaces an existing one. */
  @Put('file')
  write(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('path') p?: string,
    @Query('overwrite') overwrite?: string,
  ): Promise<{ path: string; size: number; replaced: boolean }> {
    const body = req.body as unknown;
    if (!Buffer.isBuffer(body))
      throw new BadRequestException('send the file as the raw request body');
    return this.files.write(
      id,
      p ?? '',
      body,
      overwrite === '1' || overwrite === 'true',
    );
  }

  /** Creates a directory (and its missing parents) inside a repository. */
  @Post('dir')
  mkdir(
    @Param('id') id: string,
    @Body() body: { path?: unknown },
  ): Promise<{ path: string; created: boolean }> {
    return this.files.mkdir(id, body?.path ?? '');
  }
}
