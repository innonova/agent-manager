import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AdaptersService } from '../adapters/adapters.service.js';
import { AgentsService } from '../agents/agents.service.js';
import { MANAGER_CONFIG } from '../config/config.js';
import type { ManagerConfig } from '../config/config.js';
import { DialogService } from '../dialog/dialog.service.js';
import { Project, ProjectsService } from '../projects/projects.service.js';
import { run, StreamsService } from './streams.service.js';
import type { Unsaved } from './streams.service.js';
import { clonesIn, streamFolder } from './streams.js';

/** The record a stream leaves in its own folder while it is put away: what it had cloned, and where each clone stood. */
export interface ArchiveRecord {
  archivedAt: number;
  by: string;
  clones: {
    name: string;
    /** Where it was cloned from. */
    source: string | null;
    /** The branch it was on; null for a detached HEAD. */
    branch: string | null;
    head: string | null;
    /** The branch things land on and where the remote had it then. */
    main: { ref: string; sha: string } | null;
    /** Branches the manager pushed so their commits would be somewhere else. */
    pushed: string[];
  }[];
  agents: { id: string; name: string; compacted: boolean }[];
}

/** The file in the stream's folder: it travels with the store and is readable without the manager. */
export const ARCHIVE_RECORD = 'archived.json';

/** What putting a stream away would do, and what stands in its way. */
export interface ArchivePlan {
  /** Why it cannot be put away as things are: each names what, and what would change it. */
  blocked: string[];
  /** Work that is not committed and would go with the clones: listed, and gone only on a person's word (`discard`). The first files by name. */
  uncommitted: {
    clone: string;
    count: number;
    files: string[];
    stashes: number;
  }[];
  /**
   * What `uncommitted` stood for when it was looked at, whole: sent back
   * as `discard`, it lets go of exactly what was shown, and the request
   * is refused if something else is not committed by then.
   */
  uncommittedKey: string;
  /** Branches with commits the remote has on no branch, which are pushed first, each under its own name. */
  pushes: { clone: string; branch: string; commits: number }[];
  clones: {
    name: string;
    branch: string | null;
    head: string | null;
    sizeKb: number;
  }[];
  agents: {
    id: string;
    name: string;
    state: string;
    /** Whether it would be compacted first, and when not, why. */
    compact: boolean;
    why: string;
  }[];
  reclaimKb: number;
}

/** How far a stream is on its way there or back, for whoever asked and is waiting. */
export interface ArchiveProgress {
  /** What is being done now; null when nothing is. */
  step: string | null;
  /** Why the last attempt did not go through; null when it did or none was made. */
  error: string | null;
  /** What the last attempt that went through did, in a sentence. */
  done: string | null;
}

const days = (ms: number) => {
  const d = Math.round(ms / 86_400_000);
  if (d >= 2) return `${d} days`;
  const h = Math.round(ms / 3_600_000);
  if (h >= 2) return `${h} hours`;
  return `${Math.max(1, Math.round(ms / 60_000))} minutes`;
};
const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const size = (kb: number) =>
  kb >= 1024 * 1024
    ? `${(kb / 1024 / 1024).toFixed(1)} GB`
    : kb < 512
      ? 'under 1 MB'
      : `${Math.round(kb / 1024)} MB`;

/**
 * Putting a stream away and bringing it back (`docs/design.md`,
 * "A stream put away"). Away, a stream keeps its folder in the store,
 * its home, its agents with everything the manager holds of them, and
 * loses its clones, which are the bulk and can be made again. Nothing
 * that exists only in a clone goes with it: commits are pushed first or
 * the stream stays, and files not committed go only on a person's word.
 */
@Injectable()
export class ArchiveService extends EventEmitter {
  private readonly logger = new Logger(ArchiveService.name);
  private readonly progress = new Map<string, ArchiveProgress>();

  constructor(
    @Inject(MANAGER_CONFIG) private readonly config: ManagerConfig,
    private readonly projects: ProjectsService,
    private readonly streams: StreamsService,
    private readonly agents: AgentsService,
    private readonly adapters: AdaptersService,
    private readonly dialog: DialogService,
  ) {
    super();
  }

  /** Where the stream is, and how the last attempt to move it went. */
  status(projectId: string): {
    archive: Project['archive'];
    progress: ArchiveProgress;
    record: ArchiveRecord | null;
  } {
    const p = this.streams.stream(projectId);
    return {
      archive: p.archive,
      progress: this.progress.get(p.id) ?? {
        step: null,
        error: null,
        done: null,
      },
      record: p.archive ? this.record(p) : null,
    };
  }

  private recordFile(p: Project): string {
    return path.join(
      streamFolder(this.config.storeDir, p.name),
      ARCHIVE_RECORD,
    );
  }

  private record(p: Project): ArchiveRecord | null {
    try {
      return JSON.parse(fs.readFileSync(this.recordFile(p), 'utf8'));
    } catch {
      return null;
    }
  }

  private say(p: Project, change: Partial<ArchiveProgress>): void {
    const now = {
      ...(this.progress.get(p.id) ?? { step: null, error: null, done: null }),
      ...change,
    };
    this.progress.set(p.id, now);
    this.emit('changed', p.id, this.projects.get(p.id).archive, now);
  }

  /** The stream's agents that are not archived themselves: the ones that go away with it and come back with it. */
  private agentsOf(p: Project) {
    return this.agents.list(p.id);
  }

  /**
   * Streams one of this service's operations is under way for, from the
   * first look to the last step: a second request, of either kind, is
   * refused at once, so two never work on one stream's clones or record.
   */
  private readonly owned = new Set<string>();

  private own(p: Project): void {
    if (this.owned.has(p.id))
      throw new ConflictException(
        `"${p.name}" is being put away or brought back already`,
      );
    this.owned.add(p.id);
  }

  /** What putting the stream away would do. Asks each clone's remote, so it takes seconds. */
  async plan(projectId: string): Promise<ArchivePlan> {
    const p = this.streams.stream(projectId);
    this.notAway(p);
    return (await this.look(p)).plan;
  }

  private notAway(p: Project): void {
    if (p.archive)
      throw new ConflictException(
        p.archive.state === 'archived'
          ? `"${p.name}" is put away already`
          : `"${p.name}" is on its way ${p.archive.state === 'archiving' ? 'there' : 'back'} already`,
      );
  }

  /** What in the stream is at work right now, each as a reason not to put it away: asked for the plan, and again once nothing new can start. */
  private atWork(p: Project): string[] {
    const out: string[] = [];
    const making = this.streams.busy(p.id);
    if (making.length)
      out.push(
        `${making.join(', ')} ${making.length === 1 ? 'is' : 'are'} still being cloned or set up`,
      );
    for (const { agent, status } of this.agentsOf(p)) {
      if (!['idle', 'exited', 'error'].includes(status.state))
        out.push(
          `the agent "${agent.name}" is in a turn (${status.state}); it is put away when the turn has ended`,
        );
      else if (status.background > 0)
        out.push(
          `the agent "${agent.name}" has ${status.background} background job${status.background === 1 ? '' : 's'} running`,
        );
    }
    return out;
  }

  /** One clone's part of the plan: what stands in the way, what would be pushed, what would be lost. */
  private judge(u: Unsaved): {
    blocked: string[];
    pushes: ArchivePlan['pushes'];
  } {
    const blocked: string[] = [];
    const pushes: ArchivePlan['pushes'] = [];
    const s = (n: number) => (n === 1 ? '' : 's');
    for (const q of u.unknown)
      blocked.push(
        `${u.name}: it could not be told ${q}, so what would be lost with it is not known`,
      );
    if (u.source && !u.fetched)
      blocked.push(
        `${u.name}: its remote could not be asked, so it cannot be told which of its commits are there`,
      );
    for (const b of u.unpushed) {
      if (!u.source)
        blocked.push(
          `${u.name} has no remote called origin, and ${b.commits} commit${s(b.commits)} on ${b.branch} that exist nowhere else: give it one and push, or remove the clone by hand if the work is not wanted`,
        );
      else if (b.main)
        blocked.push(
          `${u.name}: ${b.commits} commit${s(b.commits)} on ${b.branch} that ${b.commits === 1 ? 'is' : 'are'} not landed: land ${b.commits === 1 ? 'it' : 'them'}, or move ${b.commits === 1 ? 'it' : 'them'} to a branch of the stream's (which is pushed as it is)`,
        );
      else pushes.push({ clone: u.name, branch: b.branch, commits: b.commits });
    }
    if (u.detached)
      blocked.push(
        `${u.name}: ${u.detached} commit${s(u.detached)} on a detached HEAD that no branch has: put ${u.detached === 1 ? 'it' : 'them'} on a branch`,
      );
    if (u.refs.length)
      blocked.push(
        `${u.name}: ${u.refs.join(', ')} ${u.refs.length === 1 ? 'is' : 'are'} not on the remote as ${u.refs.length === 1 ? 'it is' : 'they are'} here: push ${u.refs.length === 1 ? 'it' : 'them'}, or delete ${u.refs.length === 1 ? 'it' : 'them'} if not wanted`,
      );
    for (const b of u.beyond) blocked.push(`${u.name}: ${b}`);
    return { blocked, pushes };
  }

  /** What is not committed in a set of clones, as it is now, as one value to compare: the files with their sizes and times, the stashes by their commits. */
  private keyOf(looks: Unsaved[]): string {
    return createHash('sha256')
      .update(
        JSON.stringify(
          looks
            .map((u) => [u.name, u.print])
            .sort((a, b) => a[0]!.localeCompare(b[0]!)),
        ),
      )
      .digest('hex')
      .slice(0, 32);
  }

  private async look(
    p: Project,
  ): Promise<{ plan: ArchivePlan; looks: Unsaved[] }> {
    const blocked = this.atWork(p);
    const now = Date.now();
    const agents = this.agentsOf(p).map(({ agent, status }) => {
      const can =
        !agent.host &&
        !!agent.vendorConversationId &&
        !!this.adapters.compactCommand(agent.profile);
      const used = status.usage?.context?.used ?? 0;
      const idleFor = now - status.lastActivityAt;
      const why = !can
        ? agent.vendorConversationId
          ? 'the manager cannot ask this kind of agent to compact'
          : 'it has no conversation yet'
        : used < this.config.archiveCompactMinTokens
          ? 'its context is small'
          : idleFor > this.config.archiveCompactWithinMs
            ? `it was last active ${days(idleFor)} ago: its context is no longer cached, and compacting now would cost what its first turn after coming back will`
            : 'its context is still cached: compacting now is cheap, and it comes back with a short context and its dialog word for word';
      return {
        id: agent.id,
        name: agent.name,
        state: status.state,
        compact:
          can &&
          used >= this.config.archiveCompactMinTokens &&
          idleFor <= this.config.archiveCompactWithinMs,
        why,
      };
    });
    const uncommitted: ArchivePlan['uncommitted'] = [];
    const pushes: ArchivePlan['pushes'] = [];
    const clones: ArchivePlan['clones'] = [];
    const looks: Unsaved[] = [];
    for (const c of clonesIn(p.path)) {
      const u = await this.streams.unsaved(c);
      looks.push(u);
      clones.push({
        name: u.name,
        branch: u.branch,
        head: u.head,
        sizeKb: u.sizeKb,
      });
      const j = this.judge(u);
      blocked.push(...j.blocked);
      pushes.push(...j.pushes);
      if (u.uncommitted.length || u.stashes)
        uncommitted.push({
          clone: u.name,
          count: u.uncommitted.length,
          files: u.uncommitted.slice(0, 40),
          stashes: u.stashes,
        });
    }
    return {
      plan: {
        blocked,
        uncommitted,
        uncommittedKey: this.keyOf(looks),
        pushes,
        clones,
        agents,
        reclaimKb: clones.reduce((n, c) => n + c.sizeKb, 0),
      },
      looks,
    };
  }

  /**
   * Puts the stream away. Refused at once, with everything that stands
   * in the way, when something does; otherwise answers and goes on in
   * the background (`status` says how far): its branches are pushed,
   * its agents compacted where that is cheap and stopped, the record
   * written into its folder and committed, and then, and only then, its
   * clones removed.
   *
   * `discard` is the person's word that what is not committed may go:
   * `true` for whatever that is, up to the moment the clones are
   * removed; or the plan's `uncommittedKey` for exactly what the person
   * was shown, in which case anything else found uncommitted, then or
   * later (another file, more in a file that was listed, another
   * stash), refuses.
   */
  async archive(
    projectId: string,
    opts: { discard?: unknown; compact?: unknown },
    by: string,
    userId?: string,
  ): Promise<Project> {
    const p = this.streams.stream(projectId);
    this.notAway(p);
    this.own(p);
    let handed = false;
    let marked = false;
    try {
      const { plan } = await this.look(p);
      const refused = [...plan.blocked];
      const refuse = () =>
        new HttpException(
          {
            statusCode: 409,
            code: 'archive-refused',
            message: `"${p.name}" is not put away:\n- ${refused.join('\n- ')}`,
            plan,
          },
          409,
        );
      const discard: 'all' | string | null =
        opts.discard === true
          ? 'all'
          : typeof opts.discard === 'string' && opts.discard
            ? opts.discard
            : null;
      if (plan.uncommitted.length) {
        if (discard === null)
          for (const u of plan.uncommitted)
            refused.push(
              `${u.clone}: ${[
                u.count
                  ? `${u.count} file${u.count === 1 ? '' : 's'} not committed (${u.files.slice(0, 5).join(', ')}${u.count > 5 ? ', …' : ''})`
                  : '',
                u.stashes
                  ? `${u.stashes} stashed change${u.stashes === 1 ? '' : 's'}`
                  : '',
              ]
                .filter(Boolean)
                .join(
                  ' and ',
                )} would be lost: commit what is wanted, or put the stream away with "discard"`,
            );
        else if (discard !== 'all' && discard !== plan.uncommittedKey)
          refused.push(
            'what is not committed in its clones is no longer what you were shown: look at it again',
          );
      }
      if (refused.length) throw refuse();
      // From here no person's turn is taken, no session started, no clone
      // made. What was at work is asked once more now that nothing new can
      // begin: the look at the clones took seconds.
      this.projects.setArchive(p.id, 'archiving');
      marked = true;
      const late = this.atWork(p);
      if (late.length) {
        refused.push(...late);
        throw refuse();
      }
      this.say(p, { step: 'beginning', error: null, done: null });
      const worker = this.putAway(p, plan, {
        discard,
        compact: opts.compact !== false,
        by,
        userId,
      });
      handed = true; // the worker settles the state and releases the stream from here on
      void worker.finally(() => this.owned.delete(p.id));
      return this.projects.get(p.id);
    } finally {
      if (!handed)
        try {
          // whatever threw, the stream is where it was
          if (marked) this.projects.setArchive(p.id, null);
        } finally {
          this.owned.delete(p.id); // and nobody's, whether or not the state could be put back
        }
    }
  }

  private async putAway(
    p: Project,
    plan: ArchivePlan,
    opts: {
      discard: 'all' | string | null;
      compact: boolean;
      by: string;
      userId?: string;
    },
  ): Promise<void> {
    let record: ArchiveRecord;
    let compacted = 0;
    try {
      record = await this.prepare(p, plan, opts);
      compacted = record.agents.filter((a) => a.compacted).length;
    } catch (err) {
      // Nothing is removed before the stream is marked as away: it is where it was.
      const why = (err as Error).message;
      this.logger.warn(`stream ${p.name}: not put away: ${why}`);
      this.projects.setArchive(p.id, null);
      this.say(p, { step: null, error: why });
      return;
    }
    // Away from here on, whatever happens next: what follows only takes
    // off the disk what the record can bring back, and a removal that
    // fails half way must not make the stream look as if it were there.
    this.projects.setArchive(p.id, 'archived');
    this.say(p, { step: 'removing the clones' });
    const left: string[] = [];
    for (const c of record.clones)
      try {
        await this.streams.removeClone(p.path, c.name);
      } catch (err) {
        left.push(`${c.name} (${(err as Error).message})`);
      }
    const done = `put away by ${opts.by}: ${record.clones.length - left.length} clone${record.clones.length - left.length === 1 ? '' : 's'} removed (${size(plan.reclaimKb)}), ${compacted} of ${record.agents.length} agent${record.agents.length === 1 ? '' : 's'} compacted`;
    this.logger.log(`stream ${p.name}: ${done}`);
    if (left.length)
      this.logger.warn(`stream ${p.name}: not removed: ${left.join('; ')}`);
    this.say(p, {
      step: null,
      done,
      error: left.length
        ? `it is put away, but ${left.join('; ')} could not be removed from the disk; bringing the stream back keeps what is left of them`
        : null,
    });
  }

  /** Everything that comes before the clones go, any of which may refuse: pushes, the agents, the second look, the record. */
  private async prepare(
    p: Project,
    plan: ArchivePlan,
    opts: {
      discard: 'all' | string | null;
      compact: boolean;
      by: string;
      userId?: string;
    },
  ): Promise<ArchiveRecord> {
    const clones = clonesIn(p.path);
    const pushed = new Map<string, string[]>();
    for (const push of plan.pushes) {
      this.say(p, { step: `pushing ${push.clone}: ${push.branch}` });
      const clone = clones.find((c) => c.name === push.clone);
      const failed = clone
        ? await this.streams.pushBranch(clone, push.branch)
        : 'the clone is no longer there';
      if (failed)
        throw new Error(
          `${push.clone}: ${push.branch} has ${push.commits} commit${push.commits === 1 ? '' : 's'} that exist nowhere else and could not be pushed: ${failed}`,
        );
      pushed.set(push.clone, [...(pushed.get(push.clone) ?? []), push.branch]);
    }
    // The agents as they are now, not as the plan listed them: all are
    // stopped, and the stop must be known to have happened, or something
    // may still be writing in a clone when it is looked at for the last
    // time. Compacting first is an economy where it is cheap; one that
    // fails is an economy missed, and the record says which were. Every
    // one of these is waited for, also when another has failed: nothing
    // of this attempt goes on after it has given the stream back.
    const wanted = new Set(
      plan.agents.filter((a) => a.compact).map((a) => a.id),
    );
    const agents: ArchiveRecord['agents'] = [];
    const stops = await Promise.allSettled(
      this.agentsOf(p).map(async ({ agent }) => {
        let compacted = false;
        if (wanted.has(agent.id) && opts.compact) {
          this.say(p, { step: `compacting ${agent.name}` });
          this.agents.note(
            agent.id,
            `the stream is being put away by ${opts.by}: the agent's context is compacted first, while it is still cached`,
          );
          try {
            await this.dialog.compactNow(agent.id, opts.userId, {
              archiving: true,
            });
            compacted = true;
          } catch (err) {
            this.agents.note(
              agent.id,
              `not compacted before the stream was put away: ${(err as Error).message}`,
            );
          }
        }
        try {
          await this.agents.stop(agent.id);
        } catch (err) {
          throw new Error(
            `the agent "${agent.name}" could not be stopped (${(err as Error).message}), so its clones are not known to be at rest`,
          );
        }
        agents.push({ id: agent.id, name: agent.name, compacted });
      }),
    );
    const failedStop = stops.find((r) => r.status === 'rejected');
    if (failedStop) throw (failedStop as PromiseRejectedResult).reason as Error;
    // Nothing is at work, and no agent has a session: one whose start was
    // under way when the stream was marked would show here, stopped or not.
    const still = this.atWork(p);
    for (const { agent } of this.agentsOf(p))
      if (this.agents.get(agent.id).currentSessionId)
        still.push(
          `the agent "${agent.name}" has a session that was being started when the stream was put away`,
        );
    if (still.length) throw new Error(still.join('; '));
    // Looked at again, now that nothing writes in them: what the plan saw
    // is minutes old. Everything that would refuse a request refuses here
    // too, and what is not committed must be what the person let go.
    this.say(p, { step: 'checking the clones once more' });
    const record: ArchiveRecord = {
      archivedAt: Date.now(),
      by: opts.by,
      clones: [],
      agents: agents.sort((a, b) => a.name.localeCompare(b.name)),
    };
    const looks: Unsaved[] = [];
    for (const c of clonesIn(p.path)) {
      const u = await this.streams.unsaved(c);
      looks.push(u);
      const j = this.judge(u);
      const left = [
        ...j.blocked,
        ...j.pushes.map(
          (b) =>
            `${b.clone}: ${b.commits} commit${b.commits === 1 ? '' : 's'} on ${b.branch} that the remote does not have`,
        ),
      ];
      if (left.length)
        throw new Error(
          `it changed while it was being put away, or what was pushed did not arrive: ${left.join('; ')}`,
        );
      record.clones.push({
        name: u.name,
        source: u.source,
        branch: u.branch,
        head: u.head,
        main: u.main,
        pushed: pushed.get(u.name) ?? [],
      });
    }
    if (
      looks.some((u) => u.uncommitted.length || u.stashes) &&
      opts.discard !== 'all' &&
      this.keyOf(looks) !== opts.discard
    )
      throw new Error(
        'what is not committed in its clones changed while it was being put away: it is no longer what was let go',
      );
    const file = this.recordFile(p);
    await this.streams.storeChange(
      () => fsp.writeFile(file, `${JSON.stringify(record, null, 2)}\n`),
      { stream: p.name, text: `put away by ${opts.by}` },
    );
    if (!(await this.streams.committed(path.join(p.name, ARCHIVE_RECORD)))) {
      await fsp.rm(file, { force: true });
      throw new Error(
        'the record of what it had cloned could not be committed in the store, and nothing is removed without it',
      );
    }
    for (const a of agents)
      this.agents.note(a.id, `the stream was put away by ${opts.by}`);
    return record;
  }

  /**
   * Brings a stream back: its clones are made again from the record in
   * its folder (and set up, as the registry now says), and each of its
   * agents is told at its next start how long it was away and what
   * landed meanwhile. Answers at once and goes on in the background. A
   * clone that cannot be made does not keep the stream away: it is back
   * without it, and everyone is told.
   */
  revive(projectId: string, by: string): Project {
    const p = this.streams.stream(projectId);
    if (p.archive?.state !== 'archived')
      throw new ConflictException(
        p.archive
          ? `"${p.name}" is on its way ${p.archive.state === 'archiving' ? 'there' : 'back'} already`
          : `"${p.name}" is not put away`,
      );
    const record = this.record(p);
    if (!record)
      throw new BadRequestException(
        `"${p.name}" has no ${ARCHIVE_RECORD} in its folder to say what it had cloned`,
      );
    // also while its clones are still being removed: the two would work on the same directories
    this.own(p);
    let handed = false;
    try {
      const away = this.projects.setArchive(p.id, 'reviving');
      this.say(p, { step: 'beginning', error: null, done: null });
      const worker = this.bringBack(away, record, by);
      handed = true;
      void worker.finally(() => this.owned.delete(p.id));
      return away;
    } finally {
      if (!handed)
        try {
          this.projects.setArchive(p.id, 'archived');
        } finally {
          this.owned.delete(p.id); // released whether or not the state could be put back
        }
    }
  }

  private async bringBack(
    p: Project,
    record: ArchiveRecord,
    by: string,
  ): Promise<void> {
    const away = Date.now() - record.archivedAt;
    const failed: string[] = [];
    try {
      // what a removal that was cut short left beside the clones' places
      await this.streams.sweepRemoved(p.path);
      const lines: string[] = [];
      for (const c of record.clones) {
        this.say(p, { step: `cloning ${c.name}` });
        const made = await this.streams.bringBack(p.id, {
          name: c.name,
          source: c.source,
          branch: c.branch, // also when it was main's: the remote may start a clone elsewhere by now
          head: c.head,
        });
        const dest = path.join(p.path, c.name);
        if (made.failed && !fs.existsSync(dest)) {
          failed.push(c.name);
          lines.push(`- ${c.name}: could not be cloned again: ${made.note}`);
          continue;
        }
        lines.push(await this.since(dest, c, made));
      }
      const notice = [
        `This stream was put away on ${day(record.archivedAt)} and brought back on ${day(Date.now())}, ${days(away)} later, by ${by}. While it was away its clones were off the disk; they have been made again from their remotes. What was committed and pushed then is in them; what you remember of their files is from before, and may have changed.`,
        ...(lines.length ? ['', ...lines] : []),
      ].join('\n');
      // One notice per absence: a revival asked for again replaces it.
      for (const { agent } of this.agentsOf(p)) {
        this.agents.tellAtStart(agent.id, notice);
        this.agents.note(
          agent.id,
          `the stream was brought back by ${by} after ${days(away)}; the agent is told at its next start how long it was away and what landed meanwhile`,
        );
      }
      // Back from here on, whatever happens next.
      this.projects.setArchive(p.id, null);
    } catch (err) {
      // not back yet: away as it was, with its record, to be asked for again
      const why = (err as Error).message;
      this.logger.warn(`stream ${p.name}: not brought back: ${why}`);
      this.projects.setArchive(p.id, 'archived');
      this.say(p, { step: null, error: why });
      return;
    }
    // The record goes once the stream is back: a failure here, or a stop
    // between the two, leaves a leftover file and a stream that is there;
    // never a stream that is away with nothing to come back by.
    const done = `brought back by ${by} after ${days(away)}: ${record.clones.length - failed.length} of ${record.clones.length} clone${record.clones.length === 1 ? '' : 's'} made again${failed.length ? ` (not ${failed.join(', ')})` : ''}`;
    this.logger.log(`stream ${p.name}: ${done}`);
    try {
      await this.streams.storeChange(
        () => fsp.rm(this.recordFile(p), { force: true }),
        { stream: p.name, text: `brought back by ${by}` },
      );
    } catch (err) {
      this.logger.warn(
        `stream ${p.name}: back, but its record was not tidied away: ${(err as Error).message}`,
      );
    }
    this.say(p, { step: null, done });
  }

  /** One clone's line of the notice: where it stood, where it stands, and what landed between. */
  private async since(
    cwd: string,
    c: ArchiveRecord['clones'][number],
    made: { failed: boolean; note: string | null },
  ): Promise<string> {
    const git = async (...args: string[]) => {
      const r = await run('git', args, { cwd, timeoutMs: 20_000 });
      return r.code === 0 ? r.stdout.trim() : null;
    };
    const short = (sha: string | null) => (sha ? sha.slice(0, 7) : 'unknown');
    const out: string[] = [];
    const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
    out.push(
      `- ${c.name}: was at ${short(c.head)} on ${c.branch ?? 'a detached HEAD'}` +
        (c.pushed.length
          ? ` (${c.pushed.join(', ')} ${c.pushed.length === 1 ? 'was' : 'were'} pushed when the stream was put away)`
          : '') +
        `; the clone is on ${branch ?? 'unknown'} now.`,
    );
    if (c.main) {
      const now = await git('rev-parse', c.main.ref);
      const n = Number(
        (await git('rev-list', '--count', `${c.main.sha}..${c.main.ref}`)) ??
          NaN,
      );
      if (now && now === c.main.sha)
        out.push(`  ${c.main.ref} has not moved (${short(now)}).`);
      else if (now && Number.isFinite(n)) {
        const log = await git(
          'log',
          '--format=%h %s',
          '-15',
          `${c.main.sha}..${c.main.ref}`,
        );
        out.push(
          `  ${c.main.ref} was at ${short(c.main.sha)} and is at ${short(now)}: ${n} commit${n === 1 ? '' : 's'} landed meanwhile${n > 15 ? ', the newest 15:' : ':'}`,
          ...(log ?? '').split('\n').map((l) => `    ${l}`),
          ...(n > 15
            ? [
                `    (\`git log ${short(c.main.sha)}..${c.main.ref}\` in the clone shows all)`,
              ]
            : []),
        );
      } else
        out.push(
          `  ${c.main.ref} was at ${short(c.main.sha)}, which the remote no longer has in its history: it was rewritten.`,
        );
    }
    if (made.note)
      out.push(
        made.failed
          ? `  Its setup did not go through: ${made.note}`
          : `  Not as it was: ${made.note}.`,
      );
    return out.join('\n');
  }
}
