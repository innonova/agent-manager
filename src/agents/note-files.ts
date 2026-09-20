import { BadRequestException, HttpException, Inject } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MANAGER_CONFIG, type ManagerConfig } from '../config/config.js';
import { HubService } from '../hub/hub.service.js';
import { shippedHarnessNote } from './harness.js';

/**
 * The two Markdown files an operator keeps per machine: the harness note's
 * template, and the house view of the models rendered into it. They behave
 * alike — shipped text installed next to `dist/`, a copy under `~/.config`
 * that is what actually runs, read at every session start so an edit needs
 * no restart, an empty file turning the thing off — so one implementation
 * serves both, and the UI edits them with one editor.
 */
export type NoteFileKind = 'harness' | 'models' | 'method' | 'framing';

/** The file's state on one machine: the shipped text (no file, or a file equal to it), the operator's, or turned off (an empty file). */
export interface NoteFileRow {
  host: string;
  source: 'built-in' | 'custom' | 'off';
  /**
   * The text in force (the built-in one when there is no file). Named
   * `template` for both files so the UI's editor is one component; only
   * the harness one actually has placeholders.
   */
  template: string;
  builtIn: string;
  file: string;
}

/** What tells them apart: where they live and how much text is reasonable in one. */
const KINDS: Record<
  NoteFileKind,
  { apiPath: string; maxBytes: number; limit: string }
> = {
  // the note is one page of prose plus placeholders
  harness: { apiPath: '/api/harness', maxBytes: 64 * 1024, limit: '64 KB' },
  // the models file is pasted into every note of every agent, so it stays short
  models: { apiPath: '/api/models', maxBytes: 8 * 1024, limit: '8 KB' },
  // the method is a few pages and is read on request, not pasted anywhere
  method: { apiPath: '/api/method', maxBytes: 64 * 1024, limit: '64 KB' },
  // the framing is the method's companion, read the same way
  framing: { apiPath: '/api/framing', maxBytes: 64 * 1024, limit: '64 KB' },
};

@Injectable()
export class NoteFileService {
  constructor(
    @Inject(MANAGER_CONFIG) private readonly config: ManagerConfig,
    private readonly hub: HubService,
  ) {}

  /** Where this machine's copy and the shipped text live, per kind. */
  private files(kind: NoteFileKind): { file: string; shipped: string } {
    switch (kind) {
      case 'harness':
        return {
          file: this.config.harnessFile,
          shipped: this.config.shippedHarnessFile,
        };
      case 'models':
        return {
          file: this.config.modelsFile,
          shipped: this.config.shippedModelsFile,
        };
      case 'method':
        return {
          file: this.config.methodFile,
          shipped: this.config.shippedMethodFile,
        };
      case 'framing':
        return {
          file: this.config.framingFile,
          shipped: this.config.shippedFramingFile,
        };
    }
  }

  /** This machine's row, and a spoke's for each machine a hub fronts for. */
  async list(
    kind: NoteFileKind,
    user: string,
  ): Promise<{ hosts: NoteFileRow[] }> {
    const hosts = [await this.local(kind)];
    if (this.hub.enabled) {
      await Promise.all(
        [...this.hub.spokes.values()].map(async (spoke) => {
          try {
            const r = await this.hub.call<{ hosts?: NoteFileRow[] }>(
              spoke,
              'GET',
              KINDS[kind].apiPath,
              user,
            );
            const row = r.status === 200 ? r.body?.hosts?.[0] : undefined;
            if (row) hosts.push({ ...row, host: spoke.name });
          } catch {
            // its host status says why
          }
        }),
      );
    }
    return { hosts };
  }

  /** `template`: text writes the file (empty turns it off); null writes the shipped text back into it. */
  async save(
    kind: NoteFileKind,
    user: string,
    body: { host?: unknown; template?: unknown },
  ): Promise<NoteFileRow> {
    const { host, template } = body ?? {};
    if (template !== null && typeof template !== 'string')
      throw new BadRequestException('"template" must be a string or null');
    if (
      typeof template === 'string' &&
      Buffer.byteLength(template) > KINDS[kind].maxBytes
    )
      throw new BadRequestException(
        `"template" is over ${KINDS[kind].limit}` +
          (kind === 'models'
            ? '; it is pasted into every agent’s note at session start'
            : ''),
      );
    if (typeof host === 'string' && host !== this.config.hostName) {
      const spoke = this.hub.spokes.get(host);
      if (!spoke)
        throw new HttpException(
          { statusCode: 404, message: `no host ${host}` },
          404,
        );
      const r = await this.hub.call<NoteFileRow>(
        spoke,
        'PUT',
        KINDS[kind].apiPath,
        user,
        { template },
      );
      if (r.status >= 400)
        throw new HttpException(
          r.body ?? { statusCode: r.status, message: 'spoke refused' },
          r.status,
        );
      return { ...r.body, host: spoke.name };
    }
    const { file, shipped } = this.files(kind);
    const text = template === null ? shippedHarnessNote(shipped) : template;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, text, { mode: 0o644 });
    await fs.rename(tmp, file);
    return this.local(kind);
  }

  private async local(kind: NoteFileKind): Promise<NoteFileRow> {
    const { file, shipped: shippedFile } = this.files(kind);
    let custom: string | null = null;
    try {
      custom = await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const shipped = shippedHarnessNote(shippedFile);
    return {
      host: this.config.hostName,
      source:
        custom === null || custom === shipped
          ? 'built-in'
          : custom.trim() === ''
            ? 'off'
            : 'custom',
      template: custom ?? shipped,
      builtIn: shipped,
      file,
    };
  }
}
