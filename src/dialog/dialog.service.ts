import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AdaptersService } from '../adapters/adapters.service.js';
import { AgentsService } from '../agents/agents.service.js';
import type { AgentStatus } from '../agents/agents.service.js';
import { ChatService } from '../chat/chat.service.js';
import { MANAGER_CONFIG } from '../config/config.js';
import type { ManagerConfig } from '../config/config.js';
import { DbService } from '../db/db.service.js';
import { runModel } from '../util/run-model.js';
import {
  classifierInput,
  DialogItem,
  Exchange,
  exchangesOf,
  exchangeTokens,
  fitClassifier,
  parseWeights,
  renderFiles,
  renderNotice,
  type HandbackOn,
  select,
  Selection,
  Weight,
  WeightKind,
} from './dialog.js';

interface WeightRow {
  n: number;
  kind: string;
  weight: number;
  in_force: number;
  superseded_by: number | null;
  line: string;
  classified_at: number;
  model: string;
}

/** One exchange as a list shows it: enough to choose from, not the text. */
export interface ExchangeLine {
  n: number;
  at: number;
  by: string;
  tokens: number;
  /** The classifier's line, or the first words of the person's message while it is not weighed. */
  line: string;
  kind: WeightKind | null;
  weight: number | null;
  inForce: boolean | null;
  supersededBy: number | null;
  withdrawn: boolean;
}

export interface Classified {
  /** Exchanges weighed in this run. */
  weighed: number;
  /** Of how many that were sent. */
  of: number;
  ms: number;
  model: string;
}

/** How many transcript items are read at a time while looking for the dialog in them. */
const PAGE = 2000;
/** With this many exchanges or fewer since the last weighing, another one is not worth its tokens. */
const FRESH = 3;

/**
 * The dialog of each agent with its people, kept ready to hand back
 * after a compaction (see `features/dialog-handed-back-after-compaction`
 * and the design's "The dialog after a compaction").
 *
 * The exchanges are read from the transcript and the chat, which the
 * manager already keeps. A classifier, one model call over the whole
 * dialog, weighs them: it runs ahead of a compaction, when the context
 * passes a share of its window, so that the hook Claude Code runs after
 * one finds the weights there. The hook gets a short notice naming
 * files; the dialog is in the files, written to this machine's disk.
 */
@Injectable()
export class DialogService implements OnModuleInit {
  private readonly logger = new Logger(DialogService.name);
  /** A weighing under way, per agent: one at a time, and a hand-back can wait for it. */
  private readonly running = new Map<
    string,
    { done: Promise<Classified>; since: number; model: string }
  >();
  /** How the last weighing failed, per agent, until one succeeds. */
  private readonly failed = new Map<string, { at: number; message: string }>();
  /** Agents weighed since their context last passed the threshold; cleared when it falls back under (a compaction). */
  private readonly armed = new Set<string>();
  /** The dialog as last read, per agent, for as long as nothing was added. */
  private readonly read = new Map<
    string,
    { items: number; chat: number; exchanges: Exchange[] }
  >();

  constructor(
    @Inject(MANAGER_CONFIG) private readonly config: ManagerConfig,
    private readonly dbs: DbService,
    private readonly agents: AgentsService,
    private readonly chat: ChatService,
    private readonly adapters: AdaptersService,
  ) {}

  private get db() {
    return this.dbs.db;
  }

  onModuleInit(): void {
    this.agents.on('state', (agentId, _projectId, status) =>
      this.onState(agentId, status),
    );
    this.agents.on('removed', (agentId) => {
      this.read.delete(agentId);
      this.armed.delete(agentId);
      this.inherited.delete(agentId);
      void fs
        .rm(this.dir(agentId), { recursive: true, force: true })
        .catch(() => undefined);
      void fs
        .rm(this.inheritedFile(agentId), { force: true })
        .catch(() => undefined);
    });
  }

  // ---- a fork's share of another agent's dialog ---------------------------

  private inheritedFile(agentId: string): string {
    return path.join(
      this.config.dataDir,
      'dialog-inherited',
      `${agentId}.json`,
    );
  }
  private readonly inherited = new Map<string, Exchange[]>();

  /**
   * A fork begins with another agent's conversation, so that agent's
   * dialog with the person up to the fork is the fork's too: every
   * sentence the person read and did not dispute binds the copy as it
   * binds the original. The manager builds a dialog from an agent's own
   * transcript, and a fork's begins empty, so the exchanges are copied
   * as they stand at the fork, with the weights they were given, and
   * come before the fork's own in its record. A copy, not a reference:
   * the original may be compacted, archived or deleted afterwards.
   *
   * That an agent has such a share, and up to which number, is in the
   * database (`dialog_inherited`); the exchanges are in a file written
   * whole. A fork whose file cannot be read has no dialog to give, and
   * says so: its own exchanges are numbered after the inherited ones,
   * and numbering them from one instead would put them under the
   * weights of exchanges they are not.
   */
  async inherit(agentId: string, fromAgentId: string): Promise<number> {
    const exchanges = await this.exchanges(fromAgentId);
    const file = this.inheritedFile(agentId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const staged = `${file}.writing`;
    await fs.writeFile(
      staged,
      JSON.stringify({ from: fromAgentId, exchanges }),
    );
    await fs.rename(staged, file);
    const upto = exchanges.reduce((max, e) => Math.max(max, e.n), 0);
    this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT OR REPLACE INTO dialog_inherited (agent_id, from_agent, upto, at) VALUES (?, ?, ?, ?)',
        )
        .run(agentId, fromAgentId, upto, Date.now());
      this.db
        .prepare(
          'INSERT OR REPLACE INTO dialog_weights (agent_id, n, kind, weight, in_force, superseded_by, line, classified_at, model) SELECT ?, n, kind, weight, in_force, superseded_by, line, classified_at, model FROM dialog_weights WHERE agent_id = ? AND n <= ?',
        )
        .run(agentId, fromAgentId, upto);
      const window = this.db
        .prepare('SELECT size FROM dialog_windows WHERE agent_id = ?')
        .get(fromAgentId) as { size: number } | undefined;
      if (window)
        this.db
          .prepare(
            'INSERT OR REPLACE INTO dialog_windows (agent_id, size) VALUES (?, ?)',
          )
          .run(agentId, window.size);
    })();
    this.inherited.set(agentId, exchanges);
    this.read.delete(agentId);
    return exchanges.length;
  }

  /**
   * The exchanges an agent has from the one it was forked from, and the
   * number its own begin after; nothing for an agent that is not a fork.
   */
  private async inheritedBy(
    agentId: string,
  ): Promise<{ exchanges: Exchange[]; upto: number }> {
    const row = this.db
      .prepare('SELECT upto FROM dialog_inherited WHERE agent_id = ?')
      .get(agentId) as { upto: number } | undefined;
    if (!row) return { exchanges: [], upto: 0 };
    const have = this.inherited.get(agentId);
    if (have) return { exchanges: have, upto: row.upto };
    let exchanges: Exchange[];
    try {
      const parsed = JSON.parse(
        await fs.readFile(this.inheritedFile(agentId), 'utf8'),
      ) as { exchanges?: Exchange[] };
      if (!Array.isArray(parsed.exchanges)) throw new Error('not a dialog');
      exchanges = parsed.exchanges;
    } catch (err) {
      // not kept: the next asking reads again, and a file put back is found
      throw new ConflictException(
        `the dialog this agent has from the one it was forked from cannot be read (${(err as Error).message}); its own exchanges are numbered after it, so nothing is given rather than something misnumbered`,
      );
    }
    // a read begun before `inherit` wrote a newer one must not replace it
    if (!this.inherited.has(agentId)) this.inherited.set(agentId, exchanges);
    return { exchanges: this.inherited.get(agentId)!, upto: row.upto };
  }

  /** Whether this agent is one the dialog is handed back to: a Claude agent on this machine, which is where the hook is. */
  private handedBack(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    return agent.profile === 'claude' && !agent.host && !agent.archivedAt;
  }

  /**
   * Weighs ahead of a compaction: once each time the context passes the
   * threshold share of its window, and at the compaction itself when
   * that was missed (a window that filled within one tool call).
   */
  private onState(agentId: string, status: AgentStatus): void {
    const ctx = status.usage?.context;
    if (ctx?.size && this.windows.get(agentId) !== ctx.size) {
      this.windows.set(agentId, ctx.size);
      this.db
        .prepare(
          'INSERT INTO dialog_windows (agent_id, size) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET size = excluded.size',
        )
        .run(agentId, ctx.size);
    }
    if (!this.config.dialogClassifier) return;
    const full = ctx ? ctx.used / Math.max(1, ctx.size) : 0;
    const compacting = status.activity?.kind === 'compacting';
    if (!compacting && full < this.config.dialogClassifyAt) {
      this.armed.delete(agentId); // back under: the next crossing weighs again
      return;
    }
    if (this.armed.has(agentId)) return;
    this.armed.add(agentId);
    let wanted = false;
    try {
      wanted = this.handedBack(agentId);
    } catch {
      return; // the agent is gone
    }
    if (!wanted) return;
    this.start(agentId, { onlyIfStale: true });
  }

  private dir(agentId: string): string {
    return path.join(this.config.dataDir, 'handback', agentId);
  }

  /** The agent's exchanges, read from its transcript and chat; kept until either grows. */
  async exchanges(agentId: string): Promise<Exchange[]> {
    this.agents.get(agentId); // 404 for an unknown agent
    // an archived agent's transcript is brought in on demand: before it is counted, or it counts as empty
    await this.agents.items(agentId, { tail: 1 });
    const total = this.agents.itemCount(agentId);
    const chat = this.chat.all(agentId);
    const have = this.read.get(agentId);
    if (have && have.items === total && have.chat === chat.length)
      return have.exchanges;
    // Only what is dialog is kept while paging: a transcript is mostly tool output.
    const slim: DialogItem[] = [];
    for (let start = 0; start < total; start += PAGE) {
      const end = Math.min(start + PAGE, total);
      const { items } = await this.agents.items(agentId, {
        before: end,
        limit: end - start,
      });
      for (const s of items) {
        const it = s.item;
        if (
          it.kind === 'user' ||
          it.kind === 'turn_end' ||
          (it.kind === 'text' && !it.streaming) ||
          (it.kind === 'system' && it.withdrawnFrom !== undefined)
        )
          slim.push({ index: s.index, at: s.at, item: it });
      }
    }
    const own = exchangesOf(
      slim,
      chat.map((m) => ({
        at: m.at,
        from: m.from,
        author: m.author,
        kind: m.kind,
        text: m.text,
        via: m.via,
      })),
    );
    // a fork's record begins with what it has from the agent it was forked from, numbered as there
    const before = await this.inheritedBy(agentId);
    const exchanges = before.upto
      ? [
          ...before.exchanges,
          ...own.map((e) => ({ ...e, n: e.n + before.upto })),
        ]
      : own;
    this.read.set(agentId, { items: total, chat: chat.length, exchanges });
    return exchanges;
  }

  weights(agentId: string): Map<number, Weight> {
    const rows = this.db
      .prepare('SELECT * FROM dialog_weights WHERE agent_id = ?')
      .all(agentId) as WeightRow[];
    return new Map(
      rows.map((r) => [
        r.n,
        {
          n: r.n,
          kind: r.kind as WeightKind,
          weight: r.weight,
          inForce: r.in_force === 1,
          supersededBy: r.superseded_by,
          line: r.line,
        },
      ]),
    );
  }

  /** When the dialog was last weighed, by which model, and up to which exchange. */
  weighed(agentId: string): { at: number; model: string; upTo: number } | null {
    const row = this.db
      .prepare(
        'SELECT MAX(classified_at) AS at, MAX(n) AS up_to FROM dialog_weights WHERE agent_id = ?',
      )
      .get(agentId) as { at: number | null; up_to: number | null };
    if (!row.at) return null;
    const model = (
      this.db
        .prepare(
          'SELECT model FROM dialog_weights WHERE agent_id = ? AND classified_at = ? LIMIT 1',
        )
        .get(agentId, row.at) as { model: string }
    ).model;
    return { at: row.at, model, upTo: row.up_to ?? 0 };
  }

  /** The record as a list: every exchange with its weight, for a person or the agent to choose from. */
  async list(agentId: string): Promise<{
    exchanges: ExchangeLine[];
    weighed: { at: number; model: string; upTo: number } | null;
    weighing: { since: number; model: string } | null;
    failed: { at: number; message: string } | null;
    classifier: string | null;
  }> {
    const exchanges = await this.exchanges(agentId);
    const weights = this.weights(agentId);
    return {
      exchanges: exchanges.map((e) => {
        const w = weights.get(e.n);
        const words = e.person.replace(/\s+/g, ' ').trim().split(' ');
        return {
          n: e.n,
          at: e.at,
          by: e.by,
          tokens: exchangeTokens(e),
          line:
            w?.line ||
            (words.length > 14
              ? `${words.slice(0, 14).join(' ')}…`
              : words.join(' ')),
          kind: w?.kind ?? null,
          weight: w?.weight ?? null,
          inForce: w ? w.inForce : null,
          supersededBy: w?.supersededBy ?? null,
          withdrawn: e.withdrawn,
        };
      }),
      weighed: this.weighed(agentId),
      weighing: this.weighing(agentId),
      failed: this.failed.get(agentId) ?? null,
      classifier: this.config.dialogClassifier
        ? this.classifierName(this.config.dialogClassifier)
        : null,
    };
  }

  /** One exchange, word for word. One that was taken back is not given out: the agent was meant to forget it. */
  async exchange(agentId: string, n: number): Promise<Exchange> {
    const e = (await this.exchanges(agentId)).find((x) => x.n === n);
    if (!e) throw new NotFoundException(`no exchange #${n}`);
    if (e.withdrawn)
      throw new NotFoundException(`exchange #${n} was taken back`);
    return e;
  }

  /** What the command is called in a line of text: its model when it names one, else the program. */
  private classifierName(argv: string[]): string {
    const i = argv.indexOf('--model');
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : path.basename(argv[0] ?? '');
  }

  /** The weighing under way for this agent, if any. */
  weighing(agentId: string): { since: number; model: string } | null {
    const r = this.running.get(agentId);
    return r ? { since: r.since, model: r.model } : null;
  }

  /** Starts a weighing and does not wait for it; a failure is logged and kept for `list` to say. */
  start(
    agentId: string,
    opts: { onlyIfStale?: boolean; model?: string } = {},
  ): { since: number; model: string } {
    void this.classify(agentId, opts).catch((err: Error) =>
      this.logger.warn(
        `agent ${agentId}: weighing the dialog failed: ${err.message}`,
      ),
    );
    return this.weighing(agentId)!;
  }

  /** The classifier command, with another model in its `--model` when one is asked for. */
  private command(model?: string): string[] {
    const argv = this.config.dialogClassifier;
    if (!argv)
      throw new ConflictException(
        'no classifier is configured on this manager',
      );
    if (!model) return argv;
    const i = argv.indexOf('--model');
    if (i < 0)
      throw new ConflictException(
        'the configured classifier command takes no --model',
      );
    return argv.map((a, k) => (k === i + 1 ? model : a));
  }

  /**
   * Weighs the whole dialog with the classifier, replacing the weights
   * there were: every exchange is judged again, since what came later
   * decides whether an earlier one still stands. One run per agent at a
   * time; a second caller gets the first one's result. With
   * `onlyIfStale` nothing runs when at most a few exchanges were added
   * since the last time. It takes minutes: a caller that cannot wait
   * that long uses `start` and asks `weighing` and `list` how it went.
   */
  classify(
    agentId: string,
    opts: { onlyIfStale?: boolean; model?: string } = {},
  ): Promise<Classified> {
    const going = this.running.get(agentId);
    if (going) return going.done;
    const argv = this.command(opts.model); // refused before anything is said to be under way
    this.agents.get(agentId);
    const done = this.classifyNow(agentId, argv, opts)
      .then((r) => {
        this.failed.delete(agentId);
        return r;
      })
      .catch((err: Error) => {
        this.failed.set(agentId, { at: Date.now(), message: err.message });
        throw err;
      })
      .finally(() => this.running.delete(agentId));
    this.running.set(agentId, {
      done,
      since: Date.now(),
      model: this.classifierName(argv),
    });
    return done;
  }

  private async classifyNow(
    agentId: string,
    argv: string[],
    opts: { onlyIfStale?: boolean },
  ): Promise<Classified> {
    const model = this.classifierName(argv);
    const live = (await this.exchanges(agentId)).filter((e) => !e.withdrawn);
    const last = this.weighed(agentId);
    if (
      opts.onlyIfStale &&
      last &&
      (live[live.length - 1]?.n ?? 0) - last.upTo <= FRESH
    )
      return { weighed: 0, of: live.length, ms: 0, model: last.model };
    if (live.length === 0) return { weighed: 0, of: 0, ms: 0, model };
    const started = Date.now();
    const sent = fitClassifier(live, this.weights(agentId));
    const text = await this.runClassifier(argv, classifierInput(sent));
    const weights = parseWeights(text, new Set(sent.map((e) => e.n)));
    // A run that answered for few of them is a failed run, not a verdict that the rest weigh nothing.
    if (weights.length < sent.length * 0.8)
      throw new Error(
        `the classifier answered for ${weights.length} of ${sent.length} exchanges`,
      );
    const at = Date.now();
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO dialog_weights (agent_id, n, kind, weight, in_force, superseded_by, line, classified_at, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    this.db.transaction(() => {
      for (const w of weights)
        insert.run(
          agentId,
          w.n,
          w.kind,
          w.weight,
          w.inForce ? 1 : 0,
          w.supersededBy,
          w.line,
          at,
          model,
        );
    })();
    const done = {
      weighed: weights.length,
      of: sent.length,
      ms: at - started,
      model,
    };
    this.logger.log(
      `agent ${agentId}: dialog weighed by ${model}: ${done.weighed} of ${done.of} exchanges in ${Math.round(done.ms / 1000)} s`,
    );
    return done;
  }

  /** Runs the classifier command with the input on stdin; its stdout is the answer. */
  private runClassifier(argv: string[], input: string): Promise<string> {
    return runModel(argv, input, {
      cwd: this.config.dataDir,
      timeoutMs: this.config.dialogClassifierMs,
    });
  }

  /**
   * Compacts the agent's context now, on a person's word: its dialog is
   * weighed first when that is not fresh, so that the hand-back the
   * compaction ends in has weights to choose by, and then the vendor's
   * own compaction command is sent as a turn of that person's. Answers
   * at once; the flow says what happens. For an agent whose window was
   * filled before there was a hand-back, this is how it gets a new one
   * that starts from a fresh summary and its dialog word for word.
   */
  compact(agentId: string, userId?: string): void {
    const agent = this.agents.get(agentId);
    const command = this.adapters.compactCommand(agent.profile);
    if (!command)
      throw new ConflictException(
        `the manager has no way to ask a ${agent.profile} agent to compact`,
      );
    const idle = () =>
      ['idle', 'exited'].includes(this.agents.status(agentId).state);
    if (!idle())
      throw new ConflictException(
        'the agent is in a turn; compact it when the turn has ended',
      );
    if (this.compacting.has(agentId))
      throw new ConflictException('a compaction was already asked for');
    const send = async () => {
      if (!idle()) {
        this.agents.note(
          agentId,
          'not compacted: the agent was given work while its dialog was being weighed',
        );
        return;
      }
      await this.agents.turn(agentId, command, userId);
    };
    this.compacting.add(agentId);
    void (async () => {
      try {
        // A failed weighing does not stop the compaction that was asked for.
        if (this.config.dialogClassifier && !(await this.fresh(agentId))) {
          this.agents.note(
            agentId,
            'compaction asked for: weighing the dialog first, which takes minutes',
          );
          await this.classify(agentId).catch(() => undefined);
        }
        await send();
      } catch (err) {
        this.logger.warn(
          `agent ${agentId}: compaction on request failed: ${(err as Error).message}`,
        );
        this.agents.note(agentId, `not compacted: ${(err as Error).message}`);
      } finally {
        this.compacting.delete(agentId);
      }
    })();
  }

  /** Whether the weights cover the dialog as it stands, give or take a few exchanges. */
  private async fresh(agentId: string): Promise<boolean> {
    const live = (await this.exchanges(agentId)).filter((e) => !e.withdrawn);
    const last = this.weighed(agentId);
    if (live.length === 0) return true; // nothing to weigh
    return !!last && (live[live.length - 1]?.n ?? 0) - last.upTo <= FRESH;
  }
  /** Agents a compaction on request is under way for, from the asking to the command being sent. */
  private readonly compacting = new Set<string>();

  /**
   * The agent's context window, for the budget: what its status says,
   * else what it last said. A Claude session whose model name carries
   * no `[1m]` states its window only when a turn ends, so right after a
   * restart the status has none; the first two real hand-backs fell
   * back to 200K there and handed an agent with a 1M window a fifth of
   * its dialog. Hence the size is kept, per agent, across sessions and
   * restarts of the manager, and an agent that never reported one (it
   * has not finished a turn since the manager learned to look) is taken
   * to have its vendor's usual window.
   */
  private window(agentId: string): number {
    const now = this.agents.status(agentId).usage?.context?.size;
    if (now) return now;
    const kept =
      this.windows.get(agentId) ??
      (
        this.db
          .prepare('SELECT size FROM dialog_windows WHERE agent_id = ?')
          .get(agentId) as { size: number } | undefined
      )?.size;
    // Never reported: Claude's current models have 1M windows, and the
    // two mistakes are not alike. Taking a 1M window for 200K hands the
    // agent a fifth of its dialog and nothing shows it; taking a 200K
    // window for 1M fills half of it once, shows in the header, and is
    // corrected when the first turn ends.
    return (
      kept ??
      (this.agents.get(agentId).profile === 'claude' ? 1_000_000 : 200_000)
    );
  }
  /** The window each agent last reported, as kept in `dialog_windows`. */
  private readonly windows = new Map<string, number>();

  /** What a hand-back would hold now: the selection and the files' texts, nothing written. */
  async preview(
    agentId: string,
  ): Promise<{ sel: Selection; files: string[]; budget: number }> {
    const exchanges = await this.exchanges(agentId);
    const weights = this.weights(agentId);
    const budget = Math.round(this.window(agentId) * this.config.dialogBudget);
    const sel = select(exchanges, weights, budget);
    return { sel, files: renderFiles(sel, weights), budget };
  }

  /**
   * The hand-back, after a compaction or when the agent asks for it in
   * the middle of a window (`onRequest`: an agent that has been through
   * compactions before there was a hand-back has only summaries of its
   * earlier dialog, and need not wait for the next one): the files are written and the
   * notice that names them is returned for the hook to print; null when
   * there is no dialog yet. A weighing under way is waited for, a
   * bounded time: the agent has already lost two minutes to the
   * compaction, and yesterday's weights are still right about last
   * month's exchanges.
   */
  async handback(
    agentId: string,
    on: HandbackOn = 'compact',
  ): Promise<string | null> {
    // A resumed conversation is whole: nothing to hand back, unless one
    // is still owed from a start whose hand-back did not get through.
    // And a fork resumes a copy of another agent's, and is told so here.
    const owed = () =>
      !!this.db
        .prepare('SELECT 1 FROM dialog_owed WHERE agent_id = ?')
        .get(agentId);
    if (on === 'resume') {
      const notice = this.agents.takeForkNotice(agentId);
      if (notice || !owed()) return notice;
      on = 'start';
    }
    if (on === 'start') {
      // Every new conversation asks; only one that replaces a lost one is owed anything.
      if (!owed()) return null;
      // An agent that sat unused long enough to lose its conversation was likely never weighed, or long ago.
      if (this.config.dialogClassifier)
        this.start(agentId, { onlyIfStale: true });
    }
    const going = this.running.get(agentId);
    if (going)
      await Promise.race([
        going.done.catch(() => undefined),
        new Promise((r) => setTimeout(r, this.config.dialogWaitMs)),
      ]);
    const { sel, files } = await this.preview(agentId);
    if (sel.recent.length === 0) {
      // nothing was ever said: nothing is owed either
      if (on === 'start')
        this.db
          .prepare('DELETE FROM dialog_owed WHERE agent_id = ?')
          .run(agentId);
      return null;
    }
    const dir = this.dir(agentId);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    const paths: string[] = [];
    for (const [i, text] of files.entries()) {
      const p = path.join(dir, `dialog-${i + 1}.md`);
      await fs.writeFile(p, text);
      paths.push(p);
    }
    const last = this.weighed(agentId);
    const whole = sel.recent.length + sel.kept.length;
    this.agents.note(
      agentId,
      `dialog handed back${on === 'request' ? ' on request' : on === 'start' ? ' to the new conversation' : ''}: ${whole} exchange${whole === 1 ? '' : 's'} word for word (${sel.recent.length} recent, ${sel.kept.length} earlier), ${sel.indexed.length} as index lines, about ${sel.tokens < 1000 ? sel.tokens : `${Math.round(sel.tokens / 1000)}k`} tokens` +
        ` in ${paths.length} file${paths.length === 1 ? '' : 's'} it reads when it next acts` +
        (last
          ? `; weighed by ${last.model}`
          : sel.indexed.length
            ? '; not weighed yet'
            : ''),
    );
    const notice = renderNotice(paths, sel, on);
    // Owed no longer, now that it is written and about to be answered:
    // a hand-back that failed on the way here is still owed at the next start.
    if (on === 'start')
      this.db
        .prepare('DELETE FROM dialog_owed WHERE agent_id = ?')
        .run(agentId);
    return notice;
  }
}
