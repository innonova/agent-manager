import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService, User } from './auth.service.js';

type Req = Request & { user?: User; sessionId?: string };

/** Accounts. Every user is a trusted admin: anyone can create, reset or remove anyone (but themselves). */
@Controller('api/users')
export class UsersController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  list(): { users: User[] } {
    return { users: this.auth.listUsers() };
  }

  @Post()
  create(
    @Body() body: { name?: unknown },
  ): Promise<{ user: User; password: string }> {
    return this.auth.createAccount(body?.name);
  }

  /** Only your own name. */
  @Patch('me')
  rename(@Req() req: Req, @Body() body: { name?: unknown }): { user: User } {
    return { user: this.auth.renameUser(req.user!.id, body?.name) };
  }

  @Post(':id/password')
  async resetPassword(
    @Req() req: Req,
    @Param('id') id: string,
  ): Promise<{ password: string }> {
    const password = await this.auth.resetPassword(
      id,
      id === req.user!.id ? req.sessionId : undefined,
      req.user!.id,
    );
    return { password };
  }

  @Delete(':id')
  remove(@Req() req: Req, @Param('id') id: string): { ok: true } {
    this.auth.deleteUser(id, req.user!.id);
    return { ok: true };
  }
}
