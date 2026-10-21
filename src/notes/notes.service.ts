import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { ProjectsService } from '../projects/projects.service.js';
import {
  newNoteId,
  notesMtime,
  readNote,
  readNotes,
  removeNote,
  splitText,
  today,
  writeNote,
  type NoteItem,
} from './notes-file.js';

export interface Notes {
  /** Where they live, relative to the primary repository. */
  dir: string;
  items: NoteItem[];
  /** Open items, for a count. */
  open: number;
}

const POLL_MS = 3000;

/**
 * A project's notes (see `notes-file.ts`): list, add, tick, edit, remove,
 * and a poll of the directory so every open tab sees an agent ticking a
 * note within seconds.
 */
@Injectable()
export class NotesService
  extends EventEmitter<{ changed: [projectId: string, notes: Notes] }>
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(NotesService.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly seen = new Map<string, number>();
  private polling = false;

  constructor(private readonly projects: ProjectsService) {
    super();
  }

  onModuleInit(): void {
    this.timer = setInterval(
      () =>
        void this.poll().catch((err: Error) =>
          this.logger.warn(`notes poll failed: ${err.message}`),
        ),
      POLL_MS,
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private repoOf(projectId: string): string {
    return this.projects.get(projectId).path;
  }

  async read(projectId: string): Promise<Notes> {
    const items = await readNotes(this.repoOf(projectId));
    return { dir: 'notes', items, open: items.filter((i) => !i.done).length };
  }

  async add(projectId: string, text: unknown): Promise<Notes> {
    if (typeof text !== 'string' || !text.trim())
      throw new BadRequestException('"text" is required');
    const { title, body } = splitText(text);
    const repo = this.repoOf(projectId);
    let id = newNoteId();
    while (await readNote(repo, id)) id = newNoteId(); // a collision is a new draw
    await writeNote(repo, { id, done: false, date: today(), title, body });
    return this.announce(projectId);
  }

  async update(
    projectId: string,
    id: string,
    patch: { done?: unknown; text?: unknown },
  ): Promise<Notes> {
    const repo = this.repoOf(projectId);
    const it = await readNote(repo, id);
    if (!it) throw new NotFoundException(`no note ${id}`);
    if (patch.done !== undefined) {
      if (typeof patch.done !== 'boolean')
        throw new BadRequestException('"done" must be true or false');
      it.done = patch.done;
    }
    if (patch.text !== undefined) {
      if (typeof patch.text !== 'string' || !patch.text.trim())
        throw new BadRequestException('"text" must be a non-empty string');
      const { title, body } = splitText(patch.text);
      it.title = title;
      it.body = body;
    }
    await writeNote(repo, it);
    return this.announce(projectId);
  }

  async remove(projectId: string, id: string): Promise<Notes> {
    if (!(await removeNote(this.repoOf(projectId), id)))
      throw new NotFoundException(`no note ${id}`);
    return this.announce(projectId);
  }

  private async announce(projectId: string): Promise<Notes> {
    const notes = await this.read(projectId);
    this.seen.set(projectId, await notesMtime(this.repoOf(projectId)));
    this.emit('changed', projectId, notes);
    return notes;
  }

  /** Announces projects whose notes changed since last seen: an agent ticking one, a person editing by hand. */
  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const p of this.projects.list()) {
        const mtime = await notesMtime(p.path);
        const last = this.seen.get(p.id);
        if (last === undefined) {
          this.seen.set(p.id, mtime); // first sight: nothing changed yet
          continue;
        }
        if (mtime === last) continue;
        this.seen.set(p.id, mtime);
        this.emit('changed', p.id, await this.read(p.id));
      }
    } finally {
      this.polling = false;
    }
  }
}
