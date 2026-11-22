import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
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
  /** Work that is not committed and would go with the clones: listed, and gone only on a person's word (`discard`). */
  uncommitted: {
    clone: string;
    count: number;
    files: string[];
    stashes: number;
  }[];
  /** Branches with commits no remote has, which are pushed first, each under its own name. */
  pushes: { clone: string; branch: string; commits: number }[];
  /** Remotes that could not be asked: the answer for these clones is by what they last knew. */
  unreachable: string[];
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

  /** What putting the stream away would do. Asks each clone's remote, so it takes seconds. */
  async plan(projectId: string): Promise<ArchivePlan> {
    const p = this.streams.stream(projectId);
    if (p.archive)
      throw new ConflictException(
        p.archive.state === 'archived'
          ? `"${p.name}" is put away already`
          : `"${p.name}" is on its way ${p.archive.state === 'archiving' ? 'there' : 'back'} already`,
      );
    return this.look(p);
  }

  private async look(p: Project): Promise<ArchivePlan> {
    const blocked: string[] = [];
    const making = this.streams.busy(p.id);
    if (making.length)
      blocked.push(
        `${making.join(', ')} ${making.length === 1 ? 'is' : 'are'} still being cloned or set up`,
      );
    const now = Date.now();
    const agents = this.agentsOf(p).map(({ agent, status }) => {
      const inTurn = !['idle', 'exited', 'error'].includes(status.state);
      if (inTurn)
        blocked.push(
          `the agent "${agent.name}" is in a turn (${status.state}); it is put away when the turn has ended`,
        );
      else if (status.background > 0)
        blocked.push(
          `the agent "${agent.name}" has ${status.background} background job${status.background === 1 ? '' : 's'} running`,
        );
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
    const unreachable: string[] = [];
    const clones: ArchivePlan['clones'] = [];
    for (const c of clonesIn(p.path)) {
      const u = await this.streams.unsaved(c);
      clones.push({
        name: u.name,
        branch: u.branch,
        head: u.head,
        sizeKb: u.sizeKb,
      });
      if (u.source && !u.fetched) unreachable.push(u.name);
      for (const b of u.unpushed) {
        if (!u.source)
          blocked.push(
            `${u.name} has no remote, and ${b.commits} commit${b.commits === 1 ? '' : 's'} on ${b.branch} that exist nowhere else: give it a remote and push, or remove the clone by hand if the work is not wanted`,
          );
        else if (b.main)
          blocked.push(
            `${u.name}: ${b.commits} commit${b.commits === 1 ? '' : 's'} on ${b.branch} that ${b.commits === 1 ? 'is' : 'are'} not landed: land ${b.commits === 1 ? 'it' : 'them'}, or move ${b.commits === 1 ? 'it' : 'them'} to a branch of the stream's (which is pushed as it is)`,
          );
        else
          pushes.push({ clone: u.name, branch: b.branch, commits: b.commits });
      }
      if (u.detached)
        blocked.push(
          `${u.name}: ${u.detached} commit${u.detached === 1 ? '' : 's'} on a detached HEAD that no branch has: put ${u.detached === 1 ? 'it' : 'them'} on a branch`,
        );
      if (u.uncommitted.count || u.stashes)
        uncommitted.push({
          clone: u.name,
          count: u.uncommitted.count,
          files: u.uncommitted.files,
          stashes: u.stashes,
        });
    }
    return {
      blocked,
      uncommitted,
      pushes,
      unreachable,
      clones,
      agents,
      reclaimKb: clones.reduce((n, c) => n + c.sizeKb, 0),
    };
  }

  /**
   * Puts the stream away. Refused at once, with everything that stands
   * in the way, when something does; otherwise answers and goes on in
   * the background (`status` says how far): its branches are pushed,
   * its agents compacted where that is cheap and stopped, the record
   * written into its folder, and then, and only then, its clones
   * removed.
   */
  async archive(
    projectId: string,
    opts: { discard?: unknown; compact?: unknown },
    by: string,
    userId?: string,
  ): Promise<Project> {
    const p = this.streams.stream(projectId);
    const plan = await this.plan(projectId);
    const discard = opts.discard === true;
    const refused = [...plan.blocked];
    if (!discard)
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
    if (refused.length)
      throw new HttpException(
        {
          statusCode: 409,
          code: 'archive-refused',
          message: `"${p.name}" is not put away:\n- ${refused.join('\n- ')}`,
          plan,
        },
        409,
      );
    // From here no person's turn is taken, no agent started, no clone made.
    this.projects.setArchive(p.id, 'archiving');
    this.say(p, { step: 'beginning', error: null, done: null });
    void this.putAway(p, plan, {
      discard,
      compact: opts.compact !== false,
      by,
      userId,
    }).catch((err: Error) => {
      // Nothing is removed before the stream is marked as away: it is where it was.
      this.logger.warn(`stream ${p.name}: not put away: ${err.message}`);
      this.projects.setArchive(p.id, null);
      this.say(p, { step: null, error: err.message });
    });
    return this.projects.get(p.id);
  }

  private async putAway(
    p: Project,
    plan: ArchivePlan,
    opts: { discard: boolean; compact: boolean; by: string; userId?: string },
  ): Promise<void> {
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
    // The agents: compacted where that is cheap now and dear later, then
    // stopped. A compaction that fails is an economy missed, not a loss:
    // the stream is put away all the same and the record says which.
    const agents: ArchiveRecord['agents'] = [];
    await Promise.all(
      plan.agents.map(async (a) => {
        let compacted = false;
        if (a.compact && opts.compact) {
          this.say(p, { step: `compacting ${a.name}` });
          this.agents.note(
            a.id,
            `the stream is being put away by ${opts.by}: the agent's context is compacted first, while it is still cached`,
          );
          try {
            await this.dialog.compactNow(a.id, opts.userId, {
              archiving: true,
            });
            compacted = true;
          } catch (err) {
            this.agents.note(
              a.id,
              `not compacted before the stream was put away: ${(err as Error).message}`,
            );
          }
        }
        await this.agents.stop(a.id).catch(() => undefined);
        this.agents.note(a.id, `the stream was put away by ${opts.by}`);
        agents.push({ id: a.id, name: a.name, compacted });
      }),
    );
    // Looked at again, now that nothing can change them: what the plan
    // saw may be minutes old, and an agent's turn may have ended between.
    this.say(p, { step: 'checking the clones once more' });
    const record: ArchiveRecord = {
      archivedAt: Date.now(),
      by: opts.by,
      clones: [],
      agents: agents.sort((a, b) => a.name.localeCompare(b.name)),
    };
    for (const c of clonesIn(p.path)) {
      const u = await this.streams.unsaved(c);
      const left = [
        ...u.unpushed.map(
          (b) =>
            `${b.commits} commit${b.commits === 1 ? '' : 's'} on ${b.branch}`,
        ),
        ...(u.detached ? [`${u.detached} on a detached HEAD`] : []),
      ];
      if (left.length)
        throw new Error(
          `${u.name} has work that exists nowhere else (${left.join(', ')}): it changed while the stream was being put away`,
        );
      if ((u.uncommitted.count || u.stashes) && !opts.discard)
        throw new Error(
          `${u.name} has files that are not committed: they changed while the stream was being put away`,
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
    await fsp.writeFile(
      this.recordFile(p),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    await this.streams.commitStore({
      stream: p.name,
      text: `put away by ${opts.by}`,
    });
    // Away from here on: what follows only takes off the disk what the record can bring back.
    this.projects.setArchive(p.id, 'archived');
    this.say(p, { step: 'removing the clones' });
    for (const c of record.clones)
      await this.streams.removeClone(p.path, c.name);
    const done = `put away by ${opts.by}: ${record.clones.length} clone${record.clones.length === 1 ? '' : 's'} removed (${size(plan.reclaimKb)}), ${agents.filter((a) => a.compacted).length} of ${agents.length} agent${agents.length === 1 ? '' : 's'} compacted`;
    this.logger.log(`stream ${p.name}: ${done}`);
    this.say(p, { step: null, done });
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
    const away = this.projects.setArchive(p.id, 'reviving');
    this.say(p, { step: 'beginning', error: null, done: null });
    void this.bringBack(away, record, by).catch((err: Error) => {
      this.logger.warn(`stream ${p.name}: not brought back: ${err.message}`);
      this.projects.setArchive(p.id, 'archived');
      this.say(p, { step: null, error: err.message });
    });
    return away;
  }

  private async bringBack(
    p: Project,
    record: ArchiveRecord,
    by: string,
  ): Promise<void> {
    const lines: string[] = [];
    const failed: string[] = [];
    for (const c of record.clones) {
      this.say(p, { step: `cloning ${c.name}` });
      const error = await this.streams.bringBack(p.id, {
        name: c.name,
        source: c.source,
        // the branch it was on, when that is not where a clone starts anyway
        branch:
          c.branch && c.branch !== c.main?.ref.replace(/^[^/]+\//, '')
            ? c.branch
            : null,
      });
      const dest = path.join(p.path, c.name);
      if (error && !fs.existsSync(dest)) {
        failed.push(c.name);
        lines.push(`- ${c.name}: could not be cloned again: ${error}`);
        continue;
      }
      lines.push(await this.since(dest, c, error));
    }
    const away = Date.now() - record.archivedAt;
    const notice = [
      `This stream was put away on ${day(record.archivedAt)} and brought back on ${day(Date.now())}, ${days(away)} later, by ${by}. While it was away its clones were off the disk; they have been made again from their remotes. What was committed and pushed then is in them; what you remember of their files is from before, and may have changed.`,
      ...(lines.length ? ['', ...lines] : []),
    ].join('\n');
    for (const { agent } of this.agentsOf(p)) {
      this.agents.tellAtStart(agent.id, notice);
      this.agents.note(
        agent.id,
        `the stream was brought back by ${by} after ${days(away)}; the agent is told at its next start how long it was away and what landed meanwhile`,
      );
    }
    await fsp.rm(this.recordFile(p), { force: true });
    this.projects.setArchive(p.id, null);
    await this.streams.commitStore({
      stream: p.name,
      text: `brought back by ${by}`,
    });
    const done = `brought back by ${by} after ${days(away)}: ${record.clones.length - failed.length} of ${record.clones.length} clone${record.clones.length === 1 ? '' : 's'} made again${failed.length ? ` (not ${failed.join(', ')})` : ''}`;
    this.logger.log(`stream ${p.name}: ${done}`);
    this.say(p, { step: null, done });
  }

  /** One clone's line of the notice: where it stood, where it stands, and what landed between. */
  private async since(
    cwd: string,
    c: ArchiveRecord['clones'][number],
    setupError: string | null,
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
    if (setupError) out.push(`  Its setup did not go through: ${setupError}`);
    return out.join('\n');
  }
}
