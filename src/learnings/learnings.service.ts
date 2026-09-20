import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MANAGER_CONFIG, type ManagerConfig } from '../config/config.js';
import {
  parseLearnings,
  renderEntry,
  type LearningEntry,
} from './learnings-file.js';

/** An entry is an observation with evidence, not an essay. */
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_REF_BYTES = 200;

/**
 * What was learned running agents here, one entry per paragraph, kept by
 * the manager as data: `<dataDir>/learnings.md`, one per install rather
 * than per project — it is about working under this manager, not about
 * any one project's code.
 *
 * The manager only ever appends. Rules and conclusions do not belong
 * here; they are curated into the method (`method.md`), and a curation is
 * itself an entry saying how far it read and what it changed.
 */
@Injectable()
export class LearningsService {
  /** Appends run one at a time: `n` is read from the file, so two at once would race. */
  private writing: Promise<unknown> = Promise.resolve();

  constructor(@Inject(MANAGER_CONFIG) private readonly config: ManagerConfig) {}

  get file(): string {
    return path.join(this.config.dataDir, 'learnings.md');
  }

  private async read(): Promise<LearningEntry[]> {
    try {
      return parseLearnings(await fs.readFile(this.file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  /** Entries after `since` (0 or absent: all of them), oldest last as they were written. */
  async list(since = 0): Promise<LearningEntry[]> {
    const all = await this.read();
    return since > 0 ? all.filter((e) => e.n > since) : all;
  }

  /**
   * Appends one entry and returns it as written. Serialised, and an
   * append rather than a rewrite: what is in the file stays byte for byte
   * where it was, which is what makes the log a record instead of a
   * document.
   */
  async append(input: {
    text?: unknown;
    ref?: unknown;
    by: string;
  }): Promise<LearningEntry> {
    const { text, ref } = input;
    if (typeof text !== 'string' || !text.trim())
      throw new BadRequestException('"text" is required');
    if (Buffer.byteLength(text) > MAX_TEXT_BYTES)
      throw new BadRequestException('"text" is over 16 KB');
    if (ref !== undefined && ref !== null && typeof ref !== 'string')
      throw new BadRequestException('"ref" must be a string');
    if (typeof ref === 'string' && Buffer.byteLength(ref) > MAX_REF_BYTES)
      throw new BadRequestException('"ref" is over 200 bytes');
    const at = Date.now();
    const next = this.writing.then(async () => {
      const before = await this.read();
      const entry = renderEntry(
        at,
        input.by,
        typeof ref === 'string' && ref.trim() ? ref.trim() : null,
        text,
      );
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.appendFile(this.file, before.length ? `\n${entry}` : entry);
      const all = await this.read();
      return all[all.length - 1]!;
    });
    this.writing = next.catch(() => undefined);
    return await next;
  }
}
