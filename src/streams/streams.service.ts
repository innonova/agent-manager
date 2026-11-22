import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { MANAGER_CONFIG } from '../config/config.js';
import type { ManagerConfig } from '../config/config.js';
import { DbService } from '../db/db.service.js';
import {
  parseDelegation,
  parseGroup,
  Project,
  ProjectsService,
} from '../projects/projects.service.js';
import {
  clonesIn,
  FOLDER_LINK,
  INSTRUCTIONS,
  instructionsTemplate,
  linkHome,
  REPOSITORY_NAME_RE,
  streamFolder,
  streamHome,
  STREAM_NAME_RE,
} from './streams.js';

/** A repository a stream can clone: where from, and what makes a fresh clone a working one. */
export interface Repository {
  name: string;
  /** What `git clone` is given: a URL, or a path on this machine. */
  source: string;
  /** A shell command run in a fresh clone (`npm ci`); null when a clone needs nothing. */
  setup: string | null;
  /** The untracked files copied into a fresh clone (`.env` and the like), by their paths in it. Kept by the manager, on this disk only. */
  seed: string[];
  /** The streams that have a clone of it now. */
  usedBy: string[];
  createdAt: number;
}

/** A clone in a stream's home, and how far the making of it is. */
export interface Clone {
  name: string;
  path: string;
  /** `ready`: a clone is there (made here or by hand). `failed`: the clone is there and its setup failed, or there is no clone and `message` says why. */
  state: 'cloning' | 'setting up' | 'ready' | 'failed';
  /** The branch it is on, when it is there. */
  branch: string | null;
  /** The end of what the failing command said. */
  message: string | null;
  /**
   * What of it is not landed, for a clone that is there: against the
   * repository's main as the clone last fetched it (nothing is fetched
   * to answer this). Null when it cannot be told: no remote, or a
   * remote without a main branch the clone knows of.
   */
  landing: {
    /** The branch things land on, as the clone knows it (`origin/main`). */
    main: string;
    /** Commits on the clone's branches that main does not have. */
    unlanded: number;
    /** Commits main has that the checked-out branch does not. */
    behind: number;
    /** Files changed or new in the working tree and not committed. */
    uncommitted: number;
  } | null;
}

interface RepositoryRow {
  name: string;
  source: string;
  setup: string | null;
  created_at: number;
}

/** What of a clone is nowhere else, and what it is: asked before a stream is put away. */
export interface Unsaved {
  name: string;
  path: string;
  /** Where it was cloned from; null for a repository made in place, with no remote. */
  source: string | null;
  /** Whether the remote could be asked just now. */
  fetched: boolean;
  /** The branch checked out; null when none is (a detached HEAD). */
  branch: string | null;
  head: string | null;
  /** The branch things land on, and where the remote has it. */
  main: { ref: string; sha: string } | null;
  /** Branches with commits no remote branch has. `main`: the local branch that is main's, whose commits are unlanded work and not a branch to push. */
  unpushed: { branch: string; commits: number; main: boolean }[];
  /** Commits on a detached HEAD that no branch has. */
  detached: number;
  stashes: number;
  /** Files changed or new and not committed (ignored files are not counted: dependencies and build output are what is being reclaimed). The first few by name. */
  uncommitted: { count: number; files: string[] };
  sizeKb: number;
}

/** What a machine-readable result may grow to before it is refused rather than parsed in part. */
const FULL_LIMIT = 32 * 1024 * 1024;

/**
 * A command of the manager's own: none of an agent's identity goes with
 * it, and it does not outlive its time. `out` is the end of what it
 * said on either stream, for a person to read when it fails; `stdout`
 * is all of its standard output, for a result that is parsed (a status,
 * a count), which a tail would silently cut.
 *
 * The time limit is kept whatever the command does: it runs in a
 * process group of its own, the group is asked to stop, then killed,
 * and the promise settles even if something it started holds the pipes
 * open. A command that hangs must not wedge a clone or the store.
 */
export function run(
  command: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; graceMs?: number },
): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const k of Object.keys(env))
      if (k.startsWith('AGENT_MANAGER_') || k === 'ELECTRON_RUN_AS_NODE')
        delete env[k];
    env.GIT_TERMINAL_PROMPT = '0'; // a clone that wants a password fails; it does not wait
    let out = '';
    let stdout = '';
    let overflow = false;
    const keep = (d: string) => {
      out = (out + d).slice(-8000);
    };
    let child;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true, // its own process group, so what it starts can be stopped with it
      });
    } catch (err) {
      return resolve({ code: null, out: (err as Error).message, stdout: '' });
    }
    let settled = false;
    /** Past its time: whatever it exits with from here on, it did not succeed. */
    let timedOut = false;
    let deadline: NodeJS.Timeout | null = null;
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      resolve(
        overflow
          ? {
              code: null,
              out: `${out}\n(its output is too large to read)`,
              stdout: '',
            }
          : { code: timedOut ? null : code, out, stdout },
      );
    };
    const signal = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        /* gone already */
      }
    };
    deadline = setTimeout(() => {
      timedOut = true;
      keep('\n(took too long; stopped)');
      signal('SIGTERM');
      const grace = opts.graceMs ?? 5000;
      // The group is killed after the grace whether or not the command
      // itself has gone by then: what it started may have outlived it,
      // with its output pointed elsewhere, and would go on working in a
      // clone whose setup has been reported as failed.
      setTimeout(() => signal('SIGKILL'), grace).unref();
      // whatever still holds its pipes, the caller is answered
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        settle(null);
      }, grace + 3000).unref();
    }, opts.timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      keep(d);
      if (stdout.length + d.length > FULL_LIMIT) overflow = true;
      else stdout += d;
    });
    child.stderr.setEncoding('utf8').on('data', keep);
    child.on('error', (e) => {
      keep(e.message);
      settle(null);
    });
    child.on('close', (code) => settle(code));
  });
}

const tail = (text: string, lines = 12) =>
  text.trim().split('\n').slice(-lines).join('\n');

/**
 * Streams (see `docs/streams.md`): the store and the manager's commits
 * in it, a stream's folder and home, the registry of repositories, and
 * the clones a stream makes of them. A stream is recorded as a project
 * of kind `stream` (`ProjectsService`), so everything that deals with
 * agents treats it as it treats a project.
 */
@Injectable()
export class StreamsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StreamsService.name);
  private sweep: NodeJS.Timeout | null = null;
  /** Whether the store may hold commits its remote does not: true until a push has succeeded. */
  private pushOwed = true;
  /** One thing at a time in the store's repository. */
  private storeQueue: Promise<unknown> = Promise.resolve();
  /** Clones being made or that failed: `<project id>/<name>`. What succeeded is on the disk and needs no record. */
  private readonly jobs = new Map<
    string,
    { state: Clone['state']; message: string | null }
  >();

  constructor(
    @Inject(MANAGER_CONFIG) private readonly config: ManagerConfig,
    private readonly dbs: DbService,
    private readonly projects: ProjectsService,
  ) {}

  private get db() {
    return this.dbs.db;
  }

  onModuleInit(): void {
    // Homes are mended at start: a link somebody removed, a home on a disk that was restored without it.
    for (const p of this.projects.list())
      if (p.kind === 'stream')
        try {
          linkHome(p.path, streamFolder(this.config.storeDir, p.name));
        } catch (err) {
          this.logger.warn(
            `stream ${p.name}: its home could not be mended: ${(err as Error).message}`,
          );
        }
    if (this.config.storeCommitMs > 0) {
      this.sweep = setInterval(
        () => void this.commitStore().catch(() => undefined),
        this.config.storeCommitMs,
      );
      this.sweep.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.sweep) clearInterval(this.sweep);
  }

  // ---- the store ----------------------------------------------------------

  private git(args: string[], timeoutMs = 60_000) {
    return run(
      'git',
      [
        // the manager's commits are the manager's: not the person's whose account it runs under
        '-c',
        'user.name=agent-manager',
        '-c',
        `user.email=agent-manager@${this.config.hostName}`,
        ...args,
      ],
      { cwd: this.config.storeDir, timeoutMs },
    );
  }

  private inStore<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.storeQueue.then(fn, fn);
    this.storeQueue = next.catch(() => undefined);
    return next;
  }

  /** The store exists as a git repository from the first stream on; nothing is made before that. */
  private async ensureStore(): Promise<void> {
    await fsp.mkdir(this.config.storeDir, { recursive: true });
    if (fs.existsSync(path.join(this.config.storeDir, '.git'))) return;
    const r = await this.git(['init', '-q', '-b', 'main']);
    if (r.code !== 0)
      throw new Error(`the store could not be made: ${tail(r.out, 3)}`);
    await fsp.writeFile(
      path.join(this.config.storeDir, 'README.md'),
      [
        '# The store',
        '',
        'One folder per stream: what the stream is for and how it works (`AGENTS.md`), its features (`features/`), whatever else it keeps (`docs/`).',
        '',
        'agent-manager commits what changes here, a stream at a time; agents and people write the files and leave git alone.',
        '',
      ].join('\n'),
    );
    this.logger.log(`made the store at ${this.config.storeDir}`);
  }

  /**
   * Commits what changed in the store, one commit per stream that has
   * changes, and pushes when the store has a remote. The manager is the
   * only one who commits here: many agents committing into one
   * repository sweep each other's folders into their commits and race
   * on the push. Returns the number of commits made. `why` is said in
   * the message when a person's act caused the change ("started by
   * aek"); otherwise the files changed are the message.
   */
  commitStore(why?: { stream: string; text: string }): Promise<number> {
    return this.inStore(async () => {
      if (!fs.existsSync(path.join(this.config.storeDir, '.git'))) return 0;
      const status = await this.git([
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
      ]);
      if (status.code !== 0) {
        this.logger.warn(
          `the store: git status failed: ${tail(status.out, 3)}`,
        );
        return 0;
      }
      // `XY path\0`, and for a rename the old path follows as an entry of its own
      const changed = new Map<string, string[]>();
      const entries = status.stdout.split('\0').filter(Boolean);
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]!;
        const file = e.slice(3);
        if (e[0] === 'R' || e[0] === 'C') i++;
        const top = file.includes('/') ? file.slice(0, file.indexOf('/')) : '';
        const list = changed.get(top) ?? [];
        list.push(top ? file.slice(top.length + 1) : file);
        changed.set(top, list);
      }
      let commits = 0;
      for (const [top, files] of changed) {
        const spec = top || ':(top,glob)*'; // the store's own files: its top level only
        const what =
          why && why.stream === top
            ? why.text
            : `${files.slice(0, 3).join(', ')}${files.length > 3 ? ` and ${files.length - 3} more` : ''}`;
        const add = await this.git(['add', '-A', '--', spec]);
        const commit =
          add.code === 0
            ? await this.git([
                'commit',
                '-q',
                '-m',
                `${top || 'store'}: ${what}`,
                '--',
                spec,
              ])
            : add;
        if (commit.code === 0) commits++;
        else
          this.logger.warn(
            `the store: ${top || 'its own files'} not committed: ${tail(commit.out, 3)}`,
          );
      }
      // A push that failed is tried again at the next sweep, whether or
      // not anything changed since: the remote must not stay behind for
      // want of another edit. Unknown at start, so the first sweep tries.
      if (commits) this.pushOwed = true;
      if (this.pushOwed) {
        const remote = await this.git(['remote']);
        const name =
          remote.code === 0 ? remote.stdout.trim().split('\n')[0] : '';
        if (!name) this.pushOwed = false;
        else {
          const push = await this.git(['push', '-q', name, 'HEAD'], 120_000);
          if (push.code === 0) this.pushOwed = false;
          else if (commits)
            this.logger.warn(`the store: not pushed: ${tail(push.out, 3)}`);
        }
      }
      return commits;
    });
  }

  // ---- streams ------------------------------------------------------------

  /**
   * Starts a stream: its folder in the store with an instruction file,
   * its home with the folder linked in, and its record. A folder or a
   * home that is already there is taken up as it is (a stream whose
   * record was lost, a folder that came with the store's remote): what
   * it holds is not overwritten.
   */
  async create(
    input: {
      name?: unknown;
      purpose?: unknown;
      defaultProfile?: unknown;
      delegation?: unknown;
      group?: unknown;
    },
    by: string,
  ): Promise<Project> {
    if (typeof input.name !== 'string' || !STREAM_NAME_RE.test(input.name))
      throw new BadRequestException(
        'a stream\'s "name" is lower-case letters, digits and hyphens, at most 63, starting with a letter or digit',
      );
    const name = input.name;
    if (input.purpose !== undefined && typeof input.purpose !== 'string')
      throw new BadRequestException('"purpose" must be text');
    if (
      input.defaultProfile !== undefined &&
      input.defaultProfile !== null &&
      typeof input.defaultProfile !== 'string'
    )
      throw new BadRequestException('"defaultProfile" must be a string');
    const delegation =
      input.delegation === undefined
        ? 'free'
        : parseDelegation(input.delegation);
    const group = parseGroup(input.group) ?? null;
    if (this.projects.list().some((p) => p.name === name))
      throw new ConflictException(
        `there is already a project or stream called "${name}"`,
      );
    const folder = streamFolder(this.config.storeDir, name);
    const home = streamHome(this.config.streamsDir, name);
    if (path.resolve(home) === path.resolve(this.config.storeDir))
      throw new BadRequestException(`"${name}" is where the store is`);
    await this.inStore(async () => {
      await this.ensureStore();
      await fsp.mkdir(folder, { recursive: true });
      const file = path.join(folder, INSTRUCTIONS);
      if (!fs.existsSync(file))
        await fsp.writeFile(
          file,
          instructionsTemplate(name, (input.purpose as string) ?? ''),
        );
    });
    linkHome(home, folder);
    const project = this.projects.createStream({
      name,
      home,
      defaultProfile: (input.defaultProfile as string | null) ?? null,
      delegation,
      group,
    });
    await this.commitStore({ stream: name, text: `started by ${by}` });
    this.logger.log(`stream ${name} started by ${by}: ${home}`);
    return project;
  }

  stream(projectId: string): Project {
    const p = this.projects.get(projectId);
    if (p.kind !== 'stream')
      throw new BadRequestException(
        `"${p.name}" is a project with a list of repositories, not a stream: it has no home to clone into`,
      );
    return p;
  }

  // ---- the registry of repositories --------------------------------------

  private seedDir(name: string): string {
    return path.join(this.config.dataDir, 'repositories', name, 'seed');
  }

  private seedFiles(name: string): string[] {
    const root = this.seedDir(name);
    const out: string[] = [];
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else out.push(path.relative(root, p));
      }
    };
    walk(root);
    return out.sort();
  }

  private toRepository(r: RepositoryRow, streams: Project[]): Repository {
    return {
      name: r.name,
      source: r.source,
      setup: r.setup,
      seed: this.seedFiles(r.name),
      usedBy: streams
        .filter((s) => s.repos.some((c) => !c.folder && c.name === r.name))
        .map((s) => s.name),
      createdAt: r.created_at,
    };
  }

  repositories(): Repository[] {
    const streams = this.projects.list().filter((p) => p.kind === 'stream');
    return (
      this.db
        .prepare('SELECT * FROM repositories ORDER BY name')
        .all() as RepositoryRow[]
    ).map((r) => this.toRepository(r, streams));
  }

  repository(name: string): Repository {
    const row = this.db
      .prepare('SELECT * FROM repositories WHERE name = ?')
      .get(name) as RepositoryRow | undefined;
    if (!row)
      throw new NotFoundException(
        `no repository "${name}" in the registry (\`am repos\` lists them, \`am repo add\` adds one)`,
      );
    return this.toRepository(
      row,
      this.projects.list().filter((p) => p.kind === 'stream'),
    );
  }

  /** Adds a repository to the registry, or changes what it says about one. */
  putRepository(
    name: string,
    input: { source?: unknown; setup?: unknown },
  ): Repository {
    if (!REPOSITORY_NAME_RE.test(name) || name === FOLDER_LINK)
      throw new BadRequestException(
        `"${name}" cannot name a repository: it is a directory name in a stream's home (letters, digits, dots, hyphens, underscores; not "${FOLDER_LINK}")`,
      );
    const current = this.db
      .prepare('SELECT * FROM repositories WHERE name = ?')
      .get(name) as RepositoryRow | undefined;
    const source = input.source === undefined ? current?.source : input.source;
    if (typeof source !== 'string' || !source.trim() || source.startsWith('-'))
      throw new BadRequestException(
        '"source" is what `git clone` is given: a URL, or a path on this machine',
      );
    const setup =
      input.setup === undefined ? (current?.setup ?? null) : input.setup;
    if (setup !== null && typeof setup !== 'string')
      throw new BadRequestException('"setup" is a shell command, or null');
    this.db
      .prepare(
        'INSERT INTO repositories (name, source, setup, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET source = excluded.source, setup = excluded.setup',
      )
      .run(name, source.trim(), setup?.trim() || null, Date.now());
    return this.repository(name);
  }

  removeRepository(name: string): void {
    this.repository(name);
    this.db.prepare('DELETE FROM repositories WHERE name = ?').run(name);
    fs.rmSync(path.join(this.config.dataDir, 'repositories', name), {
      recursive: true,
      force: true,
    });
  }

  /**
   * Takes untracked files a clone will need from a checkout on this
   * machine into the repository's seed, by their paths in it. They are
   * the kind of file that is not in git for a reason, so they stay in
   * the manager's data directory and go nowhere else.
   */
  async seed(
    name: string,
    input: { from?: unknown; files?: unknown },
  ): Promise<Repository> {
    this.repository(name);
    if (typeof input.from !== 'string' || !path.isAbsolute(input.from))
      throw new BadRequestException(
        '"from" is the absolute path of a checkout on this machine',
      );
    if (
      !Array.isArray(input.files) ||
      !input.files.length ||
      input.files.some((f) => typeof f !== 'string')
    )
      throw new BadRequestException(
        '"files" is a list of paths in that checkout',
      );
    const root = this.seedDir(name);
    for (const f of input.files as string[]) {
      const rel = path.normalize(f);
      if (path.isAbsolute(rel) || rel.split(path.sep).includes('..'))
        throw new BadRequestException(
          `"${f}" is not a path inside the checkout`,
        );
      const src = path.join(input.from, rel);
      if (!fs.existsSync(src) || !fs.statSync(src).isFile())
        throw new BadRequestException(`not a file: ${src}`);
      await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await fsp.copyFile(src, path.join(root, rel));
      await fsp.chmod(path.join(root, rel), 0o600);
    }
    return this.repository(name);
  }

  // ---- clones -------------------------------------------------------------

  /** The clones in a stream's home, with the ones being made. */
  async clones(projectId: string): Promise<Clone[]> {
    const p = this.stream(projectId);
    const out: Clone[] = [];
    for (const c of clonesIn(p.path)) {
      let job = this.jobs.get(`${p.id}/${c.name}`);
      // A clone whose setup was begun and not seen to finish: the manager
      // was restarted while it ran. It is there, and it is not ready.
      if (!job && fs.existsSync(this.setupPending(p.path, c.name)))
        job = {
          state: 'failed',
          message: `the clone is there; its setup did not finish (the manager was restarted while it ran). \`am use ${c.name} --again\` runs it again`,
        };
      const b = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: c.path,
        timeoutMs: 10_000,
      });
      out.push({
        name: c.name,
        path: c.path,
        state: job?.state ?? 'ready',
        branch: b.code === 0 ? b.stdout.trim() : null,
        message: job?.message ?? null,
        landing: await this.landing(c.path),
      });
    }
    for (const [key, job] of this.jobs) {
      const name = key.slice(p.id.length + 1);
      if (!key.startsWith(`${p.id}/`) || out.some((c) => c.name === name))
        continue;
      out.push({
        name,
        path: path.join(p.path, name),
        state: job.state,
        branch: null,
        message: job.message,
        landing: null,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** What of a clone is not on its repository's main: see `Clone.landing`. */
  private async landing(cwd: string): Promise<Clone['landing']> {
    const git = async (...args: string[]) => {
      const r = await run('git', args, { cwd, timeoutMs: 10_000 });
      return r.code === 0 ? r.stdout.trim() : null;
    };
    // what the remote calls its main branch, as the clone was told when it was made
    let main = await git(
      'symbolic-ref',
      '--quiet',
      '--short',
      'refs/remotes/origin/HEAD',
    );
    if (!main)
      for (const guess of ['origin/main', 'origin/master'])
        if ((await git('rev-parse', '--verify', '--quiet', guess)) !== null) {
          main = guess;
          break;
        }
    if (!main) return null;
    const unlanded = await git(
      'rev-list',
      '--count',
      '--branches',
      '--not',
      main,
    );
    const behind = await git('rev-list', '--count', `HEAD..${main}`);
    const status = await git('status', '--porcelain');
    if (unlanded === null || behind === null || status === null) return null;
    return {
      main,
      unlanded: Number(unlanded),
      behind: Number(behind),
      uncommitted: status ? status.split('\n').length : 0,
    };
  }

  /**
   * A stream takes a repository: a clone of its own in its home, the
   * seed files copied in, the setup command run. Answers at once; the
   * clone is made in the background and `clones` says how far it is.
   * The clone appears in the home whole or not at all (it is made
   * beside it and moved in); a setup that fails leaves the clone there
   * for whoever works in it to finish.
   */
  use(projectId: string, repositoryName: unknown, again = false): Clone {
    const p = this.stream(projectId);
    const away = this.projects.away(p.id);
    if (away) throw new ConflictException(away);
    if (typeof repositoryName !== 'string')
      throw new BadRequestException('"repository" names one in the registry');
    const repo = this.repository(repositoryName);
    const dest = path.join(p.path, repo.name);
    const key = `${p.id}/${repo.name}`;
    const going = this.jobs.get(key);
    if (going && (going.state === 'cloning' || going.state === 'setting up'))
      throw new ConflictException(`${repo.name} is being cloned already`);
    if (fs.existsSync(dest)) {
      // A clone that is there is not made again. Its setup can be run
      // again, on request and never by itself: a setup need not be safe
      // to repeat, and whoever asks knows what state the clone is in.
      if (!again)
        throw new ConflictException(
          `${dest} is already there; a stream has one clone of a repository` +
            (fs.existsSync(this.setupPending(p.path, repo.name)) ||
            going?.state === 'failed'
              ? ` (its setup did not finish: \`am use ${repo.name} --again\` runs it again)`
              : ''),
        );
      if (!repo.setup)
        throw new BadRequestException(
          `${repo.name} has no setup command to run again`,
        );
      const job: { state: Clone['state']; message: string | null } = {
        state: 'setting up',
        message: null,
      };
      this.jobs.set(key, job);
      void this.setUp(p, repo, dest, job).catch((err: Error) => {
        job.state = 'failed';
        job.message = err.message;
      });
      return {
        name: repo.name,
        path: dest,
        state: 'setting up',
        branch: null,
        message: null,
        landing: null,
      };
    }
    const job: { state: Clone['state']; message: string | null } = {
      state: 'cloning',
      message: null,
    };
    this.jobs.set(key, job);
    void this.makeClone(p, repo, dest, job).catch((err: Error) => {
      job.state = 'failed';
      job.message = err.message;
    });
    return {
      name: repo.name,
      path: dest,
      state: 'cloning',
      branch: null,
      message: null,
      landing: null,
    };
  }

  private async makeClone(
    p: Project,
    repo: Pick<Repository, 'name' | 'source' | 'setup'>,
    dest: string,
    job: { state: Clone['state']; message: string | null },
    /** The branch to be on, when it is not the one a clone starts on and the remote has it. */
    branch?: string | null,
  ): Promise<void> {
    const making = path.join(p.path, `.${repo.name}.cloning`);
    await fsp.rm(making, { recursive: true, force: true });
    const clone = await run('git', ['clone', '--', repo.source, making], {
      cwd: p.path,
      timeoutMs: 15 * 60_000,
    });
    if (clone.code !== 0) {
      await fsp.rm(making, { recursive: true, force: true });
      job.state = 'failed';
      job.message = `git clone ${repo.source}: ${tail(clone.out)}`;
      this.logger.warn(`stream ${p.name}: ${job.message}`);
      return;
    }
    // before the setup, which may depend on what is checked out
    if (branch)
      await run('git', ['checkout', '-q', branch, '--'], {
        cwd: making,
        timeoutMs: 60_000,
      });
    const seed = this.seedDir(repo.name);
    if (fs.existsSync(seed))
      await fsp.cp(seed, making, { recursive: true, force: false });
    // Marked before the clone is in place: a manager restarted from here
    // on finds a clone that looks whole and must not call it ready.
    if (repo.setup)
      await fsp.writeFile(this.setupPending(p.path, repo.name), repo.setup);
    await fsp.rename(making, dest);
    if (repo.setup) await this.setUp(p, repo, dest, job);
    else this.jobs.delete(`${p.id}/${repo.name}`);
    if (job.state !== 'failed')
      this.logger.log(`stream ${p.name}: cloned ${repo.name}`);
  }

  // ---- putting a stream away, and bringing it back ----------------------

  /** Whether a clone is being made or set up in the stream right now. */
  busy(projectId: string): string[] {
    const out: string[] = [];
    for (const [key, job] of this.jobs)
      if (
        key.startsWith(`${projectId}/`) &&
        (job.state === 'cloning' || job.state === 'setting up')
      )
        out.push(key.slice(projectId.length + 1));
    return out;
  }

  /**
   * What of a clone is nowhere else: the question before it is removed.
   * The remote is asked first (a branch somebody deleted there is no
   * longer a place the commits are), and when it cannot be reached the
   * answer is by what the clone last knew, and says so.
   */
  async unsaved(clone: { name: string; path: string }): Promise<Unsaved> {
    const cwd = clone.path;
    const git = async (...args: string[]) => {
      const r = await run('git', args, { cwd, timeoutMs: 20_000 });
      return r.code === 0 ? r.stdout.trim() : null;
    };
    const source = await git('remote', 'get-url', 'origin');
    let fetched = false;
    if (source) {
      const f = await run('git', ['fetch', '--quiet', '--prune', 'origin'], {
        cwd,
        timeoutMs: 120_000,
      });
      fetched = f.code === 0;
    }
    const landing = await this.landing(cwd);
    const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
    const head = await git('rev-parse', 'HEAD');
    const mainSha = landing ? await git('rev-parse', landing.main) : null;
    // the local branch that is main's: what is ahead on it is unlanded work, not a branch to push
    const mainLocal = landing ? landing.main.replace(/^[^/]+\//, '') : null;
    const unpushed: Unsaved['unpushed'] = [];
    for (const b of (
      (await git('for-each-ref', '--format=%(refname:short)', 'refs/heads')) ??
      ''
    )
      .split('\n')
      .filter(Boolean)) {
      const n = Number(
        (await git('rev-list', '--count', b, '--not', '--remotes')) ?? 0,
      );
      if (n) unpushed.push({ branch: b, commits: n, main: b === mainLocal });
    }
    const detached =
      branch === 'HEAD'
        ? Number(
            (await git(
              'rev-list',
              '--count',
              'HEAD',
              '--not',
              '--remotes',
              '--branches',
            )) ?? 0,
          )
        : 0;
    const stashes = ((await git('stash', 'list')) ?? '')
      .split('\n')
      .filter(Boolean).length;
    const status = await run(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { cwd, timeoutMs: 60_000 },
    );
    const files: string[] = [];
    if (status.code === 0) {
      const entries = status.stdout.split('\0').filter(Boolean);
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]!;
        files.push(e.slice(3));
        if (e[0] === 'R' || e[0] === 'C') i++;
      }
    }
    const du = await run('du', ['-sk', cwd], { cwd, timeoutMs: 120_000 });
    return {
      name: clone.name,
      path: clone.path,
      source,
      fetched,
      branch: branch === 'HEAD' ? null : branch,
      head,
      main: landing && mainSha ? { ref: landing.main, sha: mainSha } : null,
      unpushed,
      detached,
      stashes,
      uncommitted: { count: files.length, files: files.slice(0, 40) },
      sizeKb: du.code === 0 ? Number(du.stdout.split(/\s/)[0]) || 0 : 0,
    };
  }

  /** Pushes a branch of a clone to its remote under its own name; null when that went, else what git said. */
  async pushBranch(
    clone: { path: string },
    branch: string,
  ): Promise<string | null> {
    const r = await run(
      'git',
      [
        'push',
        '--quiet',
        'origin',
        `refs/heads/${branch}:refs/heads/${branch}`,
      ],
      { cwd: clone.path, timeoutMs: 5 * 60_000 },
    );
    return r.code === 0 ? null : tail(r.out, 6);
  }

  /** Takes a clone off the disk, with the notes beside it. */
  async removeClone(home: string, name: string): Promise<void> {
    await fsp.rm(path.join(home, name), { recursive: true, force: true });
    await fsp.rm(this.setupPending(home, name), { force: true });
    await fsp.rm(path.join(home, `.${name}.cloning`), {
      recursive: true,
      force: true,
    });
  }

  /**
   * Makes a clone the stream had before it was put away, and waits for
   * it: as the registry describes the repository now, or from where the
   * clone came when the registry does not know it (one made by hand: no
   * setup is known for it). One that is there already is left as it is.
   * Null when it is there and ready; otherwise what went wrong.
   */
  async bringBack(
    projectId: string,
    clone: { name: string; source: string | null; branch: string | null },
  ): Promise<string | null> {
    const p = this.stream(projectId);
    const dest = path.join(p.path, clone.name);
    if (fs.existsSync(dest)) return null;
    const row = this.db
      .prepare('SELECT * FROM repositories WHERE name = ?')
      .get(clone.name) as RepositoryRow | undefined;
    const source = row?.source ?? clone.source;
    if (!source)
      return 'it had no remote, and the registry does not know it: nowhere to clone it from';
    const key = `${p.id}/${clone.name}`;
    const job: { state: Clone['state']; message: string | null } = {
      state: 'cloning',
      message: null,
    };
    this.jobs.set(key, job);
    try {
      await this.makeClone(
        p,
        { name: clone.name, source, setup: row?.setup ?? null },
        dest,
        job,
        clone.branch,
      );
    } catch (err) {
      job.state = 'failed';
      job.message = (err as Error).message;
    }
    return job.state === 'failed' ? job.message : null;
  }

  /** Where it is noted that a clone's setup was begun and not seen to finish: beside the clone, out of its way. */
  private setupPending(home: string, name: string): string {
    return path.join(home, `.${name}.setup-pending`);
  }

  /** Runs a clone's setup command; the note that it is pending goes when it succeeds. */
  private async setUp(
    p: Project,
    repo: Pick<Repository, 'name' | 'setup'>,
    dest: string,
    job: { state: Clone['state']; message: string | null },
  ): Promise<void> {
    job.state = 'setting up';
    await fsp.writeFile(this.setupPending(p.path, repo.name), repo.setup ?? '');
    const setup = await run('bash', ['-lc', repo.setup ?? 'true'], {
      cwd: dest,
      timeoutMs: 30 * 60_000,
    });
    if (setup.code !== 0) {
      job.state = 'failed';
      job.message = `the clone is there; its setup (${repo.setup}) failed: ${tail(setup.out)}`;
      this.logger.warn(`stream ${p.name}: ${repo.name}: setup failed`);
      return;
    }
    await fsp.rm(this.setupPending(p.path, repo.name), { force: true });
    this.jobs.delete(`${p.id}/${repo.name}`);
  }
}
