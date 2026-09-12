import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { Feature, FeaturesService } from './features.service.js';

@Controller('api/projects/:id/features')
export class FeaturesController {
  constructor(private readonly features: FeaturesService) {}

  @Get()
  async list(@Param('id') id: string): Promise<{ features: Feature[] }> {
    return { features: await this.features.list(id) };
  }

  @Post()
  async create(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ): Promise<{ feature: Feature }> {
    return { feature: await this.features.create(id, body) };
  }

  @Get(':slug')
  async get(
    @Param('id') id: string,
    @Param('slug') slug: string,
  ): Promise<{ feature: Feature }> {
    return { feature: await this.features.get(id, slug) };
  }

  @Patch(':slug')
  async patch(
    @Param('id') id: string,
    @Param('slug') slug: string,
    @Body() body: { status?: unknown },
  ): Promise<{ feature: Feature }> {
    return { feature: await this.features.setStatus(id, slug, body?.status) };
  }

  @Post(':slug/respond')
  async respond(
    @Param('id') id: string,
    @Param('slug') slug: string,
    @Body() body: { text?: unknown; status?: unknown },
  ): Promise<{ feature: Feature }> {
    return { feature: await this.features.respond(id, slug, body ?? {}) };
  }
}
