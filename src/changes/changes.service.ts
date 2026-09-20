import fs from 'node:fs/promises';
import path from 'node:path';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import { MAX_FILE_BYTES } from '../files/files.service.js';
import { NotRegularFileError, readRegular } from '../util/read-regular.js';
import { FeaturesService } from '../features/features.service.js';
import { ProjectsService, Repo } from '../projects/projects.service.js';
import { isSlug } from '../features/feature-file.js';
import {
  changedFiles,
  commitFiles,
  commitMeta,
  commitsIn,
  countIn,
  head,
  log,
  resolveCommit,
  showAt,
  sizeAt,
} from './git.js';
import { ReadCursorsService } from './read-cursors.service.js';
import { RunsService, Run } from '../runs/runs.service.js';
import type { ChangedFile } from './git.js';

export interface RepoChanges {
  repo: string;
  /** The commit the changes are measured from; null when there is none (not a repository). */
  base: string | null;
  head: string | null;
  /** Why the base is not what was asked for, if it is not. */
  note: string | null;
  files: (ChangedFile & { path: string })[];
}

export interface CommitRow {
  repo: string;
  hash: string;
  shortHash: string;
  subject: string;
  /** The git author name recorded on the commit. */
  author: string;
  /** Author time, milliseconds. */
  at: number;
  /** The agent's name: the turn that made it if recorded, else a run window, else null (the git author is then who). */
  agent: string | null;
  agentId: string | null;
  /** The feature slug when the commit falls in a run's window, else null. */
  feature: string | null;
  /** The session and transcript item index of the commit, when a turn made it and it was recorded; for linking into the transcript. */
  sessionId: string | null;
  item: number | null;
  /** True when the commit is after the caller's read cursor in its repository. */
  unread: boolean;
}

export interface WorkingRow {
  repo: string;
  /** The agent of a run still open in this repository, if any. */
  agent: string | null;
  /** Uncommitted changed-file count. */
  files: number;
  /** HEAD, so the uncommitted diff is fetched with the existing changes routes at `base=<head>`. */
  head: string;
}

export interface FileDiff {
  path: string;
  base: string | null;
  /** Content at the base, null if the file did not exist there. */
  before: string | null;
  /** Working-tree content, null if the file is gone. */
  after: string | null;
  binary: boolean;
  truncated: boolean;
}

/**
 * What changed in a project's repositories since a base: the caller's read
 * cursor (`read`, the default), a feature's recorded range
 * (`feature:<slug>`), or any commit-ish. Always measured against the
 * working tree, so uncommitted work shows too. Read-only; the tree is
 * never touched, so an agent mid-turn is no concern beyond staleness.
 */
@Injectable()
export class ChangesService {
  constructor(
    private readonly dbs: DbService,
    private readonly projects: ProjectsService,
    private readonly features: FeaturesService,
    private readonly cursors: ReadCursorsService,
    private readonly runs: RunsService,
  ) {}

  private get db() {
    return this.dbs.db;
  }

  /** Resolves the base spec to a commit per repository, with a note when it had to fall back. */
  private async baseFor(
    userId: string,
    projectId: string,
    repo: Repo,
    spec: string,
  ): Promise<{
    base: string | null;
    head: string | null;
    note: string | null;
  }> {
    const h = await head(repo.path);
    if (!h) return { base: null, head: null, note: 'not a git repository' };
    if (spec === 'read') {
      const cursor = this.cursors.get(userId, projectId, repo.name);
      if (!cursor)
        return {
          base: h,
          head: h,
          note: 'nothing marked read yet; showing uncommitted changes',
        };
      const ok = await resolveCommit(repo.path, cursor);
      return ok
        ? { base: ok, head: h, note: null }
        : {
            base: h,
            head: h,
            note: 'the last read commit no longer exists (history rewritten); showing uncommitted changes',
          };
    }
    if (spec.startsWith('feature:')) {
      const slug = spec.slice('feature:'.length);
      if (!isSlug(slug)) throw new BadRequestException('bad feature slug');
      const range = this.features.range(projectId, slug)[repo.name];
      if (!range)
        return {
          base: h,
          head: h,
          note: 'no range recorded for this feature here; showing uncommitted changes',
        };
      const ok = await resolveCommit(repo.path, range.base);
      if (!ok)
        return {
          base: h,
          head: h,
          note: 'the feature’s base commit no longer exists (history rewritten); showing uncommitted changes',
        };
      return {
        base: ok,
        head: h,
        note: range.end
          ? `feature ended at ${range.end.slice(0, 8)}; later changes show too`
          : null,
      };
    }
    const ok = await resolveCommit(repo.path, spec);
    if (!ok) throw new BadRequestException(`unknown base: ${spec}`);
    return { base: ok, head: h, note: null };
  }

  async list(
    userId: string,
    projectId: string,
    spec = 'read',
  ): Promise<{ base: string; repos: RepoChanges[] }> {
    const project = this.projects.get(projectId);
    const repos: RepoChanges[] = [];
    for (const repo of project.repos) {
      const b = await this.baseFor(userId, projectId, repo, spec);
      const listed = b.base ? await changedFiles(repo.path, b.base) : [];
      // A failed git call is not a clean tree: say so rather than show nothing.
      const files = listed ?? [];
      const note =
        listed === null
          ? [b.note, 'could not read the changes (git failed or timed out)']
              .filter(Boolean)
              .join('; ')
          : b.note;
      repos.push({
        repo: repo.name,
        base: b.base,
        head: b.head,
        note,
        files: files.map((f) => ({
          ...f,
          path: `${repo.name}/${f.path}`,
          ...(f.oldPath ? { oldPath: `${repo.name}/${f.oldPath}` } : {}),
        })),
      });
    }
    return { base: spec, repos };
  }

  async file(
    userId: string,
    projectId: string,
    rel: unknown,
    spec = 'read',
  ): Promise<FileDiff> {
    const project = this.projects.get(projectId);
    if (
      typeof rel !== 'string' ||
      !rel ||
      rel.split('/').some((seg) => seg === '..' || seg === '')
    )
      throw new BadRequestException(
        '"path" is required and may not leave the project',
      );
    const [repoName, ...rest] = rel.split('/');
    const repo = project.repos.find((r) => r.name === repoName);
    if (!repo || rest.length === 0)
      throw new NotFoundException(`no such file: ${rel}`);
    const inRepo = rest.join('/');
    const b = await this.baseFor(userId, projectId, repo, spec);
    // Sizes first, so an oversized file is reported without being read.
    const beforeSize = b.base ? await sizeAt(repo.path, b.base, inRepo) : null;
    let afterSize: number | null = null;
    try {
      const st = await fs.stat(path.join(repo.path, ...rest));
      if (!st.isFile())
        throw new BadRequestException(`not a regular file: ${rel}`);
      afterSize = st.size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      afterSize = null;
    }
    const size = Math.max(beforeSize ?? 0, afterSize ?? 0);
    if (size > MAX_FILE_BYTES)
      return {
        path: rel,
        base: b.base,
        before: null,
        after: null,
        binary: false,
        truncated: true,
      };
    const beforeBuf =
      beforeSize === null ? null : await showAt(repo.path, b.base!, inRepo);
    let afterBuf: Buffer | null = null;
    if (afterSize !== null) {
      // bounded and regular-file-only; a failure other than "gone" is an error, not a deletion
      let read: Awaited<ReturnType<typeof readRegular>>;
      try {
        read = await readRegular(path.join(repo.path, ...rest), MAX_FILE_BYTES);
      } catch (err) {
        if (err instanceof NotRegularFileError)
          throw new BadRequestException(`not a regular file: ${rel}`);
        throw err;
      }
      if (read?.truncated)
        return {
          path: rel,
          base: b.base,
          before: null,
          after: null,
          binary: false,
          truncated: true,
        };
      afterBuf = read?.buf ?? null;
    }
    const binary = [beforeBuf, afterBuf].some((buf) =>
      buf?.subarray(0, 8192).includes(0),
    );
    if (size > MAX_FILE_BYTES || binary)
      return {
        path: rel,
        base: b.base,
        before: null,
        after: null,
        binary,
        truncated: size > MAX_FILE_BYTES,
      };
    return {
      path: rel,
      base: b.base,
      before: beforeBuf ? beforeBuf.toString('utf8') : null,
      after: afterBuf ? afterBuf.toString('utf8') : null,
      binary: false,
      truncated: false,
    };
  }

  /**
   * The project's commits across its repositories, newest first, each with
   * who made it and which feature it belongs to. Who is attributed in three
   * steps: the recorded turn that made it (an agent committing through this
   * manager, with its session and transcript item, so a client can link
   * into the conversation), else the run window's agent, else the git
   * author. The feature comes from the run window: a commit in a run's
   * `base..end` (in that run's own repository) carries its slug, and when
   * it falls in more than one, the innermost wins — the run whose base is
   * the latest ancestor of the commit, ties broken by the most recent
   * start. Nothing is cached: every call reads git afresh, so a rebase or
   * amend is reflected at once.
   */
  async commits(
    userId: string,
    projectId: string,
    filter: {
      repo?: string;
      feature?: string;
      agent?: string;
      since?: string;
      limit?: number;
    } = {},
  ): Promise<{ commits: CommitRow[]; working: WorkingRow[]; sinceCount: number }> {
    const project = this.projects.get(projectId);
    if (filter.since !== undefined && typeof filter.since !== 'string')
      throw new BadRequestException('"since" must be a commit');
    const limit = Math.min(Math.max(Number(filter.limit) || 100, 1), 500);
    // The run window source: all of the project's runs (recent first). A
    // project with more than this many runs would not attribute a commit
    // older than the window, which is outside anything a reader browses.
    const runs = this.runs.list({ projectId, limit: 1000 });
    const out: CommitRow[] = [];
    const working: WorkingRow[] = [];
    let sinceCount = 0;
    for (const repo of project.repos) {
      if (filter.repo && repo.name !== filter.repo) continue;
      const h = await head(repo.path);
      if (!h) continue; // not a git repository
      // uncommitted work, and the agent of a run still open in this repo
      const uncommitted = await changedFiles(repo.path, 'HEAD');
      if (uncommitted && uncommitted.length) {
        const open = runs.find(
          (r) => r.repo === repo.name && r.endedAt === null,
        );
        working.push({
          repo: repo.name,
          agent: open?.agentName ?? null,
          files: uncommitted.length,
          head: h,
        });
      }
      // the read cursor: commits after it are unread; a missing or vanished
      // cursor means nothing is marked read, so everything is unread
      const cursor = this.cursors.get(userId, projectId, repo.name);
      const resolvedCursor = cursor
        ? await resolveCommit(repo.path, cursor)
        : null;
      const unread = resolvedCursor
        ? ((await commitsIn(repo.path, resolvedCursor, h)) ?? null)
        : null; // null => treat all as unread
      let since: string | undefined;
      if (filter.since) {
        const ok = await resolveCommit(repo.path, filter.since);
        if (ok) since = ok;
      }
      const commits = (await log(repo.path, { limit, since })) ?? [];
      const attribution = await this.attribute(repo.path, repo.name, commits, runs);
      const turns = this.turnRecords(projectId, repo.name);
      for (const c of commits) {
        const isUnread = unread ? unread.has(c.hash) : true;
        if (isUnread) sinceCount++;
        const a = attribution.get(c.hash);
        const rec = turns.get(c.hash);
        // who: the recorded turn first, then the run window, then git author
        const agentId = rec?.agentId ?? a?.agentId ?? null;
        const agentName = rec?.agentName ?? a?.agent ?? null;
        if (filter.feature && a?.feature !== filter.feature) continue;
        if (filter.agent && agentId !== filter.agent) continue;
        out.push({
          repo: repo.name,
          hash: c.hash,
          shortHash: c.hash.slice(0, 8),
          subject: c.subject,
          author: c.author,
          at: c.at,
          agent: agentName,
          agentId,
          feature: a?.feature ?? null,
          sessionId: rec?.sessionId ?? null,
          item: rec?.item ?? null,
          unread: isUnread,
        });
      }
    }
    out.sort((a, b) => b.at - a.at);
    return { commits: out.slice(0, limit), working, sinceCount };
  }

  /**
   * Which run, if any, each of `commits` belongs to. Candidate runs are
   * those for this repository whose `base..end` window contains the commit
   * (an open run runs to HEAD); the innermost wins — the run whose base sits
   * latest in the log, ties by the most recent start.
   */
  private async attribute(
    cwd: string,
    repoName: string,
    commits: { hash: string }[],
    runs: Run[],
  ): Promise<Map<string, { agent: string; agentId: string; feature: string }>> {
    const pos = new Map(commits.map((c, i) => [c.hash, i]));
    const mine = runs.filter((r) => r.repo === repoName && r.baseCommit);
    // each run's window as a set of hashes, and where its base sits in the log
    const windows: {
      run: Run;
      set: Set<string>;
      basePos: number;
    }[] = [];
    for (const r of mine) {
      const set = await commitsIn(cwd, r.baseCommit!, r.endCommit ?? 'HEAD');
      if (!set) continue; // a base that no longer resolves contributes no window
      windows.push({ run: r, set, basePos: pos.get(r.baseCommit!) ?? Infinity });
    }
    const result = new Map<
      string,
      { agent: string; agentId: string; feature: string }
    >();
    for (const c of commits) {
      let best: (typeof windows)[number] | null = null;
      for (const w of windows) {
        if (!w.set.has(c.hash)) continue;
        if (
          !best ||
          w.basePos < best.basePos || // base later in history (newer) wins
          (w.basePos === best.basePos && w.run.startedAt > best.run.startedAt)
        )
          best = w;
      }
      if (best)
        result.set(c.hash, {
          agent: best.run.agentName,
          agentId: best.run.agentId,
          feature: best.run.slug,
        });
    }
    return result;
  }

  /** The recorded turn behind each commit of a repository, by hash (agents committing through this manager). */
  private turnRecords(
    projectId: string,
    repoName: string,
  ): Map<string, { agentId: string; agentName: string; sessionId: string; item: number }> {
    const rows = this.db
      .prepare(
        'SELECT hash, agent_id, agent_name, session_id, item_index FROM commit_attributions WHERE project_id = ? AND repo = ?',
      )
      .all(projectId, repoName) as {
      hash: string;
      agent_id: string;
      agent_name: string;
      session_id: string;
      item_index: number;
    }[];
    return new Map(
      rows.map((r) => [
        r.hash,
        {
          agentId: r.agent_id,
          agentName: r.agent_name,
          sessionId: r.session_id,
          item: r.item_index,
        },
      ]),
    );
  }

  /** How many commits are unread across the project's repositories (the tab badge). */
  async commitCount(userId: string, projectId: string): Promise<number> {
    const project = this.projects.get(projectId);
    let count = 0;
    for (const repo of project.repos) {
      const h = await head(repo.path);
      if (!h) continue;
      const cursor = this.cursors.get(userId, projectId, repo.name);
      const resolved = cursor ? await resolveCommit(repo.path, cursor) : null;
      if (!resolved) {
        // nothing marked read (or the cursor was rewritten away): every
        // commit is unread, but a whole-history count is meaningless, so
        // count only what a page would show
        const commits = await log(repo.path, { limit: 500 });
        count += commits?.length ?? 0;
        continue;
      }
      count += (await countIn(repo.path, resolved, h)) ?? 0;
    }
    return count;
  }

  /**
   * One commit's diff: with no `path`, the list of files it changed; with a
   * `path`, that file's content before (its parent) and after (the commit).
   * A hash that no longer exists is a 404, so a rebased-away commit selected
   * in another tab fails cleanly rather than 500.
   */
  async commit(
    userId: string,
    projectId: string,
    repoName: string,
    hash: string,
    rel?: unknown,
  ): Promise<
    | { repo: string; hash: string; subject: string; author: string; at: number; files: ChangedFile[] }
    | FileDiff
  > {
    const project = this.projects.get(projectId);
    const repo = project.repos.find((r) => r.name === repoName);
    if (!repo) throw new NotFoundException(`no such repository: ${repoName}`);
    if (!/^[0-9a-fA-F]{4,64}$/.test(hash))
      throw new BadRequestException('bad commit hash');
    const full = await resolveCommit(repo.path, hash);
    if (!full) throw new NotFoundException(`no such commit: ${hash}`);
    if (rel === undefined) {
      const meta = await commitMeta(repo.path, full);
      const files = (await commitFiles(repo.path, full)) ?? [];
      return {
        repo: repo.name,
        hash: full,
        subject: meta?.subject ?? '',
        author: meta?.author ?? '',
        at: meta?.at ?? 0,
        files,
      };
    }
    if (
      typeof rel !== 'string' ||
      !rel ||
      rel.split('/').some((seg) => seg === '..' || seg === '')
    )
      throw new BadRequestException('"path" may not leave the repository');
    // the parent side follows a rename to the old path
    const files = (await commitFiles(repo.path, full)) ?? [];
    const entry = files.find((f) => f.path === rel);
    const parent = `${full}^`;
    const beforePath = entry?.oldPath ?? rel;
    const beforeSize =
      entry?.status === 'added' ? null : await sizeAt(repo.path, parent, beforePath);
    const afterSize =
      entry?.status === 'deleted' ? null : await sizeAt(repo.path, full, rel);
    const size = Math.max(beforeSize ?? 0, afterSize ?? 0);
    if (size > MAX_FILE_BYTES)
      return { path: rel, base: parent, before: null, after: null, binary: false, truncated: true };
    const beforeBuf =
      beforeSize === null ? null : await showAt(repo.path, parent, beforePath);
    const afterBuf =
      afterSize === null ? null : await showAt(repo.path, full, rel);
    const binary = [beforeBuf, afterBuf].some((buf) =>
      buf?.subarray(0, 8192).includes(0),
    );
    if (binary)
      return { path: rel, base: parent, before: null, after: null, binary: true, truncated: false };
    return {
      path: rel,
      base: parent,
      before: beforeBuf ? beforeBuf.toString('utf8') : null,
      after: afterBuf ? afterBuf.toString('utf8') : null,
      binary: false,
      truncated: false,
    };
  }

  /** Marks everything up to HEAD as read for this user, in one repository or all. */
  async markRead(
    userId: string,
    projectId: string,
    repoName?: unknown,
  ): Promise<{ repos: { repo: string; commit: string }[] }> {
    const project = this.projects.get(projectId);
    if (repoName !== undefined && typeof repoName !== 'string')
      throw new BadRequestException('"repo" must be a string');
    if (repoName && !project.repos.some((r) => r.name === repoName))
      throw new NotFoundException(`no such repository: ${repoName}`);
    return { repos: await this.cursors.markRead(userId, projectId, repoName) };
  }
}
