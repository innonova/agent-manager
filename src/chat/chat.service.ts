import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { AgentsService, MANAGER_AUTHOR } from '../agents/agents.service.js';
import type { Agent } from '../agents/agents.service.js';
import { MANAGER_CONFIG } from '../config/config.js';
import type { ManagerConfig } from '../config/config.js';
import { DbService } from '../db/db.service.js';
import { PushService } from '../push/push.service.js';

export type ChatKind = 'message' | 'decision' | 'question';
/** How a person's message travelled: beside a working agent, as a turn, or as a steer. */
export type ChatVia = 'aside' | 'turn' | 'steer';

export interface ChatMessage {
  id: number;
  agentId: string;
  from: 'agent' | 'person';
  /** Who wrote it: a person's name, `agent-<name>` for another agent, the agent's own name for its own. */
  author: string;
  kind: ChatKind;
  important: boolean;
  text: string;
  /** The message this one answers, with enough of it to read the answer alone. */
  re: { id: number; kind: ChatKind; excerpt: string } | null;
  via: ChatVia | null;
  /** Images that travelled with it (a turn or a steer); they are in the transcript, not here. */
  images: number;
  at: number;
  /** A person's message: when the agent got it (fetched it, or was handed it as a turn). */
  readAt: number | null;
  /** A question: when it stopped being open, and how (`answer`, `person` dismissed it, `agent` closed it). */
  closedAt: number | null;
  closedBy: 'answer' | 'person' | 'agent' | null;
}

export interface ChatSummary {
  /** A person's messages the agent has not read yet. */
  unread: number;
  /** The agent's questions still open. */
  questions: number;
  /** The newest message's id, for a client to tell what it has not seen. */
  last: number;
}

interface Row {
  id: number;
  agent_id: string;
  from_agent: number;
  author_id: string | null;
  author_name: string;
  kind: string;
  important: number;
  text: string;
  reply_to: number | null;
  via: string | null;
  images: number;
  created_at: number;
  read_at: number | null;
  closed_at: number | null;
  closed_by: string | null;
}

export interface ChatEvents {
  /** Messages were added or changed (read, closed); the summary is the agent's after the change. */
  changed: [
    agentId: string,
    projectId: string,
    messages: ChatMessage[],
    summary: ChatSummary,
  ];
}

const MAX_TEXT = 16_000;
const KINDS: ChatKind[] = ['message', 'decision', 'question'];
/** In these states a turn is under way: a message goes beside it, not as a turn of its own. */
const IN_TURN = new Set(['working', 'starting', 'waiting-permission']);

const excerpt = (text: string, n = 100): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const hhmm = (at: number): string => {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const ago = (ms: number): string => {
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 90) return `${min} min ago`;
  return `${Math.round(min / 60)} h ago`;
};
const isBusy = (err: unknown): boolean =>
  err instanceof HttpException && err.getStatus() === 409;

/**
 * The chat between people and one agent: a record of its own beside the
 * transcript, which neither side has to stop for.
 *
 * A person's message to a working agent is kept unread and the agent is
 * told that it exists, not what it says: its hook asks after a tool call
 * (`notice`), and an agent without a hook gets a one-line steer. The
 * agent fetches the messages when it chooses (`read`), which is what
 * marks them read. A message to an agent that is not in a turn starts
 * one and carries the text along, and so does whatever is still unread
 * when a turn ends, so nothing sits unread beside an idle agent. Kept
 * outside the agent's context, a person's words survive a compaction.
 *
 * The agent writes with its own token: a message, a decision, a
 * question. A question stays open until it is answered (a reply to
 * it), dismissed or closed; it and an important decision reach the
 * people's phones.
 */
@Injectable()
export class ChatService
  extends EventEmitter<ChatEvents>
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ChatService.name);
  /** Per agent: when it was last told of unread messages, and up to which one. In memory: a restart tells it once more. */
  private readonly noticed = new Map<string, { at: number; upTo: number }>();
  /** Agents a delivery is in flight for; one at a time each. */
  private readonly delivering = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    @Inject(MANAGER_CONFIG) private readonly config: ManagerConfig,
    private readonly dbs: DbService,
    private readonly agents: AgentsService,
    private readonly push: PushService,
  ) {
    super();
  }

  private get db() {
    return this.dbs.db;
  }

  onModuleInit(): void {
    // The end of a turn is when what is still unread is handed over.
    this.agents.on('state', (agentId, _projectId, status) => {
      if (status.state === 'idle')
        setImmediate(() => void this.deliver(agentId).catch(() => undefined));
    });
    this.agents.on('removed', (agentId) => this.noticed.delete(agentId));
    this.agents.on('archived', (agentId) => this.closeAll(agentId));
    if (this.config.chatSweepMs > 0) {
      this.timer = setInterval(
        () =>
          void this.sweep().catch((err: Error) =>
            this.logger.warn(`chat sweep failed: ${err.message}`),
          ),
        this.config.chatSweepMs,
      );
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private toMessage(r: Row, agentName: string): ChatMessage {
    let re: ChatMessage['re'] = null;
    if (r.reply_to !== null) {
      const to = this.db
        .prepare(
          'SELECT id, kind, text FROM chat_messages WHERE id = ? AND agent_id = ?',
        )
        .get(r.reply_to, r.agent_id) as
        { id: number; kind: string; text: string } | undefined;
      if (to)
        re = {
          id: to.id,
          kind: to.kind as ChatKind,
          excerpt: excerpt(to.text),
        };
    }
    return {
      id: r.id,
      agentId: r.agent_id,
      from: r.from_agent ? 'agent' : 'person',
      author: r.from_agent ? agentName : r.author_name,
      kind: r.kind as ChatKind,
      important: !!r.important,
      text: r.text,
      re,
      via: (r.via as ChatVia | null) ?? null,
      images: r.images,
      at: r.created_at,
      readAt: r.read_at,
      closedAt: r.closed_at,
      closedBy: (r.closed_by as ChatMessage['closedBy']) ?? null,
    };
  }

  private rows(ids: number[]): Row[] {
    if (!ids.length) return [];
    return this.db
      .prepare(
        `SELECT * FROM chat_messages WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
      )
      .all(...ids) as Row[];
  }

  private unreadRows(agentId: string): Row[] {
    return this.db
      .prepare(
        'SELECT * FROM chat_messages WHERE agent_id = ? AND from_agent = 0 AND read_at IS NULL ORDER BY id',
      )
      .all(agentId) as Row[];
  }

  summary(agentId: string): ChatSummary {
    const r = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(from_agent = 0 AND read_at IS NULL), 0) AS unread,
           COALESCE(SUM(from_agent = 1 AND kind = 'question' AND closed_at IS NULL), 0) AS questions,
           COALESCE(MAX(id), 0) AS last
         FROM chat_messages WHERE agent_id = ?`,
      )
      .get(agentId) as ChatSummary;
    return { unread: r.unread, questions: r.questions, last: r.last };
  }

  /** Every agent of the project that has a chat, for the agent list. */
  projectSummary(projectId: string): (ChatSummary & { agentId: string })[] {
    return this.db
      .prepare(
        `SELECT c.agent_id AS agentId,
           COALESCE(SUM(c.from_agent = 0 AND c.read_at IS NULL), 0) AS unread,
           COALESCE(SUM(c.from_agent = 1 AND c.kind = 'question' AND c.closed_at IS NULL), 0) AS questions,
           MAX(c.id) AS last
         FROM chat_messages c JOIN agents a ON a.id = c.agent_id
         WHERE a.project_id = ? GROUP BY c.agent_id`,
      )
      .all(projectId) as (ChatSummary & { agentId: string })[];
  }

  /** The chat, oldest first: the last `limit` messages, or those before `before`. */
  list(
    agentId: string,
    opts: { before?: number; limit?: number } = {},
  ): { messages: ChatMessage[]; summary: ChatSummary } {
    const agent = this.agents.get(agentId);
    const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
    const rows = (
      opts.before
        ? this.db
            .prepare(
              'SELECT * FROM chat_messages WHERE agent_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
            )
            .all(agentId, opts.before, limit)
        : this.db
            .prepare(
              'SELECT * FROM chat_messages WHERE agent_id = ? ORDER BY id DESC LIMIT ?',
            )
            .all(agentId, limit)
    ) as Row[];
    return {
      messages: rows.reverse().map((r) => this.toMessage(r, agent.name)),
      summary: this.summary(agentId),
    };
  }

  private announce(agent: Agent, ids: number[]): ChatMessage[] {
    const messages = this.rows(ids).map((r) => this.toMessage(r, agent.name));
    this.emit(
      'changed',
      agent.id,
      agent.projectId,
      messages,
      this.summary(agent.id),
    );
    return messages;
  }

  private checkText(text: unknown): string {
    if (typeof text !== 'string' || !text.trim())
      throw new BadRequestException('"text" is required');
    if (text.length > MAX_TEXT)
      throw new BadRequestException(`"text" is at most ${MAX_TEXT} characters`);
    return text.trim();
  }

  private replyTarget(agentId: string, replyTo: unknown): Row | null {
    if (replyTo === undefined || replyTo === null) return null;
    if (typeof replyTo !== 'number' || !Number.isInteger(replyTo))
      throw new BadRequestException('"replyTo" must be a message id');
    const row = this.db
      .prepare('SELECT * FROM chat_messages WHERE id = ? AND agent_id = ?')
      .get(replyTo, agentId) as Row | undefined;
    if (!row) throw new NotFoundException(`no message ${replyTo} in this chat`);
    return row;
  }

  /**
   * The agent says something in its own chat: a message, a decision
   * (important when it matters a lot) or a question. A question and an
   * important decision are pushed to the people's devices; the rest is
   * there when they look.
   */
  async agentSays(
    agentId: string,
    body: {
      text?: unknown;
      kind?: unknown;
      important?: unknown;
      replyTo?: unknown;
    },
  ): Promise<ChatMessage> {
    const agent = this.agents.get(agentId);
    const text = this.checkText(body?.text);
    const kind = (body?.kind ?? 'message') as ChatKind;
    if (!KINDS.includes(kind))
      throw new BadRequestException(`"kind" is one of ${KINDS.join(', ')}`);
    const important = body?.important === true;
    const to = this.replyTarget(agentId, body?.replyTo);
    const id = Number(
      this.db
        .prepare(
          'INSERT INTO chat_messages (agent_id, from_agent, author_id, author_name, kind, important, text, reply_to, created_at) VALUES (?, 1, NULL, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          agentId,
          agent.name,
          kind,
          important ? 1 : 0,
          text,
          to?.id ?? null,
          Date.now(),
        ).lastInsertRowid,
    );
    const [message] = this.announce(agent, [id]);
    if (kind === 'question' || important)
      void this.push
        .notify(null, {
          title:
            kind === 'question'
              ? `${agent.name} asks`
              : kind === 'decision'
                ? `${agent.name} decided`
                : `${agent.name} says`,
          body: excerpt(text, 180),
          url: `/projects/${agent.projectId}/agents/${agent.id}`,
          tag: `chat-${agent.id}-${id}`,
        })
        .catch((err: Error) =>
          this.logger.warn(`chat push failed: ${err.message}`),
        );
    return message!;
  }

  /**
   * Someone says something to the agent. In a turn it is an aside: kept
   * unread, the agent told that it exists. With `steer` it goes into the
   * running turn as a steer where the vendor can take one, and is an
   * aside where it cannot. Outside a turn it starts one, together with
   * anything older still unread. A reply to an open question answers it.
   */
  async personSays(
    agentId: string,
    user: { id: string; name: string },
    body: {
      text?: unknown;
      replyTo?: unknown;
      steer?: unknown;
      images?: unknown;
    },
  ): Promise<{ message: ChatMessage; mode: ChatVia }> {
    const agent = this.agents.get(agentId);
    if (agent.archivedAt) throw new ConflictException('agent is archived');
    const text = this.checkText(body?.text);
    const to = this.replyTarget(agentId, body?.replyTo);
    const images = Array.isArray(body?.images) ? body.images.length : 0;
    const steer = body?.steer === true;
    const inTurn = () => IN_TURN.has(this.agents.status(agentId).state);
    if (images && inTurn() && !steer)
      throw new BadRequestException(
        'an aside cannot carry an image; steer with it, or send it when the turn has ended',
      );
    const now = Date.now();
    const id = Number(
      this.db
        .prepare(
          "INSERT INTO chat_messages (agent_id, from_agent, author_id, author_name, text, reply_to, via, images, created_at) VALUES (?, 0, ?, ?, ?, ?, 'aside', ?, ?)",
        )
        .run(agentId, user.id, user.name, text, to?.id ?? null, images, now)
        .lastInsertRowid,
    );
    const changed = [id];
    const forget = () =>
      this.db.prepare('DELETE FROM chat_messages WHERE id = ?').run(id);
    let mode: ChatVia = 'aside';
    try {
      if (!inTurn()) {
        // not in a turn: this starts one, with whatever else was unread
        let sent = false;
        try {
          sent = await this.deliver(agentId, {
            starter: id,
            images: body?.images,
          });
        } catch (err) {
          if (!isBusy(err)) throw err; // a turn began meanwhile: an aside after all
        }
        if (sent) mode = 'turn';
        else if (images)
          throw new ConflictException(
            'a turn began meanwhile, and an aside cannot carry an image; steer with it, or send it when the turn has ended',
          );
      } else if (steer) {
        let went: string = 'unsteerable';
        try {
          went = await this.agents.turn(
            agentId,
            this.compose([this.rows([id])[0]!]),
            user.id,
            {
              steer: true,
              hold: false,
              images: body?.images,
            },
          );
        } catch (err) {
          if (!isBusy(err)) throw err; // starting, or waiting on a permission: not steerable now
        }
        if (went === 'steered' || went === 'sent') {
          mode = went === 'steered' ? 'steer' : 'turn';
          this.db
            .prepare(
              'UPDATE chat_messages SET via = ?, read_at = ? WHERE id = ?',
            )
            .run(mode, Date.now(), id);
        } else if (images)
          throw new ConflictException(
            'this agent cannot take an image in the middle of a turn; send it when the turn has ended',
          );
      }
    } catch (err) {
      forget();
      throw err;
    }
    // a reply to an open question is its answer
    if (
      to &&
      to.from_agent &&
      to.kind === 'question' &&
      to.closed_at === null
    ) {
      this.db
        .prepare(
          "UPDATE chat_messages SET closed_at = ?, closed_by = 'answer' WHERE id = ?",
        )
        .run(now, to.id);
      changed.push(to.id);
    }
    const message = this.announce(this.agents.get(agentId), changed).find(
      (m) => m.id === id,
    )!;
    if (mode === 'aside') void this.nudge(agentId);
    return { message, mode };
  }

  /**
   * A turn that went through the turn route (`am turn`, a feature
   * handed over, another agent's brief) is part of the conversation
   * too: recorded as said, already delivered.
   */
  record(
    agentId: string,
    user: { id: string; name: string },
    text: string,
    via: 'turn' | 'steer',
    images: number,
  ): void {
    let agent: Agent;
    try {
      agent = this.agents.get(agentId);
    } catch {
      return; // forgotten meanwhile
    }
    const now = Date.now();
    const id = Number(
      this.db
        .prepare(
          'INSERT INTO chat_messages (agent_id, from_agent, author_id, author_name, text, via, images, created_at, read_at) VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          agentId,
          user.id,
          user.name,
          text.slice(0, MAX_TEXT),
          via,
          images,
          now,
          now,
        ).lastInsertRowid,
    );
    this.announce(agent, [id]);
  }

  /** What the agent is handed: one message as it was written, several under a line that says so. */
  private compose(rows: Row[]): string {
    const about = (r: Row): string | null => {
      if (r.reply_to === null) return null;
      const to = this.db
        .prepare('SELECT id, kind, text FROM chat_messages WHERE id = ?')
        .get(r.reply_to) as
        { id: number; kind: string; text: string } | undefined;
      if (!to) return null;
      return `${to.kind === 'question' ? 'your question' : 'your message'} #${to.id} ("${excerpt(to.text, 80)}")`;
    };
    if (rows.length === 1) {
      const a = about(rows[0]!);
      if (!a) return rows[0]!.text;
      return `${a.startsWith('your question') ? 'Answer to' : 'About'} ${a}:\n\n${rows[0]!.text}`;
    }
    const parts = rows.map((r) => {
      const a = about(r);
      return `${r.author_name}, ${hhmm(r.created_at)}${a ? `, about ${a}` : ''}:\n${r.text}`;
    });
    return `${rows.length} chat messages, written while you worked:\n\n${parts.join('\n\n')}`;
  }

  /**
   * Hands everything unread to an agent that is not in a turn, as one
   * turn, and marks it read. True when a turn was sent. A refusal (a
   * turn began meanwhile, the daemon is away) throws and leaves the
   * messages unread for the next attempt.
   */
  private async deliver(
    agentId: string,
    opts: { starter?: number; images?: unknown } = {},
  ): Promise<boolean> {
    if (this.delivering.has(agentId)) return false;
    this.delivering.add(agentId);
    try {
      const unread = this.unreadRows(agentId);
      if (!unread.length) return false;
      if (this.agents.get(agentId).archivedAt) return false;
      const authors = new Set(unread.map((r) => r.author_id));
      const author =
        authors.size === 1 && unread[0]!.author_id
          ? unread[0]!.author_id
          : MANAGER_AUTHOR;
      await this.agents.turn(agentId, this.compose(unread), author, {
        images: opts.images,
      });
      const now = Date.now();
      const mark = this.db.prepare(
        'UPDATE chat_messages SET read_at = ?, via = ? WHERE id = ?',
      );
      // the one that started the turn went as a turn; the older ones stay what they were, asides
      for (const r of unread)
        mark.run(now, r.id === opts.starter ? 'turn' : r.via, r.id);
      const others = unread.filter((r) => r.id !== opts.starter);
      if (others.length)
        this.announce(
          this.agents.get(agentId),
          others.map((r) => r.id),
        );
      this.noticed.delete(agentId);
      return true;
    } finally {
      this.delivering.delete(agentId);
    }
  }

  /** Whether the agent's current session has a hook that asks about the chat. */
  private hasHook(agent: Agent): boolean {
    if (!agent.currentSessionId) return false;
    const row = this.db
      .prepare('SELECT hook_session FROM agents WHERE id = ?')
      .get(agent.id) as { hook_session: string | null } | undefined;
    return row?.hook_session === agent.currentSessionId;
  }

  /**
   * What to tell a working agent about its unread messages now, or null:
   * at once when there is a message it has not been told of, and again
   * every `chatRepeatMs` while something stays unread. That they exist,
   * from whom and since when; never what they say.
   */
  private noticeText(agentId: string): string | null {
    const unread = this.unreadRows(agentId);
    if (!unread.length) {
      this.noticed.delete(agentId);
      return null;
    }
    const now = Date.now();
    const newest = unread[unread.length - 1]!.id;
    const last = this.noticed.get(agentId);
    if (last && last.upTo >= newest && now - last.at < this.config.chatRepeatMs)
      return null;
    this.noticed.set(agentId, { at: now, upTo: newest });
    const n = unread.length;
    const names = [...new Set(unread.map((r) => r.author_name))].join(', ');
    const answers = unread.filter((r) => {
      if (r.reply_to === null) return false;
      const to = this.db
        .prepare('SELECT kind FROM chat_messages WHERE id = ?')
        .get(r.reply_to) as { kind: string } | undefined;
      return to?.kind === 'question';
    }).length;
    const what =
      n === 1
        ? answers
          ? 'an answer to your question'
          : '1 unread message'
        : `${n} unread messages${answers ? ` (${answers === n ? 'answers' : `${answers} of them answers`} to your questions)` : ''}`;
    const it = n === 1 ? 'it' : 'them';
    return `Chat: ${what} from ${names}, ${n === 1 ? 'written' : 'the oldest written'} ${ago(now - unread[0]!.created_at)}. \`am chat\` prints ${it} and marks ${it} read. This only says that ${n === 1 ? 'it exists' : 'they exist'}: carry on, and read ${it} at the next natural point in the work.`;
  }

  /** The agent's hook asking, after a tool call: remembered as a session with a hook, and answered with what to say, if anything. */
  notice(agentId: string): { text: string | null } {
    const agent = this.agents.get(agentId);
    if (agent.currentSessionId)
      this.db
        .prepare(
          'UPDATE agents SET hook_session = ? WHERE id = ? AND hook_session IS NOT ?',
        )
        .run(agent.currentSessionId, agentId, agent.currentSessionId);
    return { text: this.noticeText(agentId) };
  }

  /** An agent without a hook is told by a one-line steer, the manager's own; where no steer can go, the end of the turn delivers. */
  private async nudge(agentId: string): Promise<void> {
    let agent: Agent;
    try {
      agent = this.agents.get(agentId);
      if (this.hasHook(agent)) return; // its hook asks
      if (this.agents.status(agentId).state !== 'working') return;
    } catch {
      return;
    }
    const before = this.noticed.get(agentId);
    const text = this.noticeText(agentId);
    if (!text) return;
    try {
      const went = await this.agents.turn(agentId, text, MANAGER_AUTHOR, {
        steer: true,
        hold: false,
      });
      if (went === 'unsteerable') throw new Error('not steerable now');
    } catch {
      // not told after all: the next sweep, or the end of the turn, will
      if (before) this.noticed.set(agentId, before);
      else this.noticed.delete(agentId);
    }
  }

  /**
   * The agent reads its chat: everything unread, marked read as of now.
   * Fetching is the act of reading, so only the agent itself does this.
   */
  read(agentId: string): { messages: ChatMessage[]; summary: ChatSummary } {
    const agent = this.agents.get(agentId);
    const unread = this.unreadRows(agentId);
    if (unread.length) {
      const now = Date.now();
      const mark = this.db.prepare(
        'UPDATE chat_messages SET read_at = ? WHERE id = ?',
      );
      for (const r of unread) mark.run(now, r.id);
    }
    this.noticed.delete(agentId);
    const messages = unread.length
      ? this.announce(
          agent,
          unread.map((r) => r.id),
        )
      : [];
    return { messages, summary: this.summary(agentId) };
  }

  /** A question stops being open without an answer: a person dismissed it, or the agent no longer needs it. */
  close(
    agentId: string,
    messageId: number,
    by: 'person' | 'agent',
  ): ChatMessage {
    const agent = this.agents.get(agentId);
    const row = this.db
      .prepare('SELECT * FROM chat_messages WHERE id = ? AND agent_id = ?')
      .get(messageId, agentId) as Row | undefined;
    if (!row) throw new NotFoundException(`no message ${messageId}`);
    if (!row.from_agent || row.kind !== 'question')
      throw new BadRequestException(`message ${messageId} is not a question`);
    if (row.closed_at === null)
      this.db
        .prepare(
          'UPDATE chat_messages SET closed_at = ?, closed_by = ? WHERE id = ?',
        )
        .run(Date.now(), by, messageId);
    return this.announce(agent, [messageId])[0]!;
  }

  /** An archived agent waits for no answer: its open questions close as its own, so nothing stays pinned for a session that ended. */
  private closeAll(agentId: string): void {
    const open = this.db
      .prepare(
        "SELECT id FROM chat_messages WHERE agent_id = ? AND from_agent = 1 AND kind = 'question' AND closed_at IS NULL",
      )
      .all(agentId) as { id: number }[];
    if (open.length === 0) return;
    this.db
      .prepare(
        "UPDATE chat_messages SET closed_at = ?, closed_by = 'agent' WHERE agent_id = ? AND from_agent = 1 AND kind = 'question' AND closed_at IS NULL",
      )
      .run(Date.now(), agentId);
    try {
      this.announce(
        this.agents.get(agentId),
        open.map((r) => r.id),
      );
    } catch {
      /* forgotten meanwhile */
    }
  }

  /**
   * What a state change did not deliver: an idle agent with unread
   * messages gets them (a manager restart, a refusal at the turn's end),
   * and a working one without a hook is told again when it is time.
   */
  private async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const ids = (
        this.db
          .prepare(
            'SELECT DISTINCT agent_id FROM chat_messages WHERE from_agent = 0 AND read_at IS NULL',
          )
          .all() as { agent_id: string }[]
      ).map((r) => r.agent_id);
      for (const id of ids) {
        let state: string;
        try {
          state = this.agents.status(id).state;
        } catch {
          continue;
        }
        if (state === 'idle') await this.deliver(id).catch(() => undefined);
        else if (state === 'working') await this.nudge(id);
      }
    } finally {
      this.sweeping = false;
    }
  }
}
