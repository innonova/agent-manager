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

  /** The message that makes this profile's CLI compact its context, or null when the manager has no way to ask. */
  compactCommand(profile: string): string | null {
    return this.factories.get(profile)?.create().compactCommand ?? null;
  }

  /** The file a profile's vendor keeps a conversation in on this machine; null when the manager cannot name it (or the profile is unknown). */
  conversationFile(
    profile: string,
    cwd: string,
    conversationId: string,
  ): string | null {
    return (
      this.factories
        .get(profile)
        ?.create()
        .conversationFile?.(cwd, conversationId) ?? null
    );
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
