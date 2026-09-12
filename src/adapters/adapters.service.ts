import { Injectable, NotFoundException } from '@nestjs/common';
import type { AdapterFactory, AgentAdapter } from './adapter.js';
import { claudeAdapterFactory } from './claude.adapter.js';
import { codexAdapterFactory } from './codex.adapter.js';
import { copilotAdapterFactory } from './copilot.adapter.js';
import { fakeAdapterFactory } from './fake.adapter.js';

/** Which adapter speaks for which daemon profile. */
@Injectable()
export class AdaptersService {
  private readonly factories = new Map<string, AdapterFactory>([
    [claudeAdapterFactory.profile, claudeAdapterFactory],
    [codexAdapterFactory.profile, codexAdapterFactory],
    [copilotAdapterFactory.profile, copilotAdapterFactory],
    [fakeAdapterFactory.profile, fakeAdapterFactory],
  ]);

  supports(profile: string): boolean {
    return this.factories.has(profile);
  }

  create(profile: string): AgentAdapter {
    const f = this.factories.get(profile);
    if (!f) throw new NotFoundException(`no adapter for profile "${profile}"`);
    return f.create();
  }

  profiles(): string[] {
    return [...this.factories.keys()];
  }
}
