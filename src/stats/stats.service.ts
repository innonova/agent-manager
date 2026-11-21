import { Injectable, OnModuleInit } from '@nestjs/common';
import { AgentsService } from '../agents/agents.service.js';
import { ChatService } from '../chat/chat.service.js';
import { Stats, statsOf, TurnLog } from './stats.js';

/** How many transcript items are read at a time. */
const PAGE = 2000;

/**
 * An agent's statistics, read off its transcript (see `stats.ts`). The
 * turn log is kept per agent and fed only what was added since it was
 * last asked for: a transcript is append-only and long, and a first
 * reading of a big one takes seconds.
 */
@Injectable()
export class StatsService implements OnModuleInit {
  private readonly logs = new Map<string, { upTo: number; log: TurnLog }>();
  /** One reading per agent at a time: two at once would feed the same items twice. */
  private readonly reading = new Map<string, Promise<TurnLog>>();

  constructor(
    private readonly agents: AgentsService,
    private readonly chat: ChatService,
  ) {}

  onModuleInit(): void {
    this.agents.on('removed', (agentId) => this.logs.delete(agentId));
  }

  private log(agentId: string): Promise<TurnLog> {
    const going = this.reading.get(agentId);
    if (going) return going;
    const run = (async () => {
      const total = this.agents.itemCount(agentId);
      let have = this.logs.get(agentId);
      // fewer items than were read: the transcript was rebuilt, start over
      if (!have || total < have.upTo) {
        have = { upTo: 0, log: new TurnLog() };
        this.logs.set(agentId, have);
      }
      for (let start = have.upTo; start < total; start += PAGE) {
        const end = Math.min(start + PAGE, total);
        const { items } = await this.agents.items(agentId, {
          before: end,
          limit: end - start,
        });
        for (const s of items)
          have.log.feed({ at: s.at, sessionId: s.sessionId, item: s.item });
        have.upTo = end;
      }
      return have.log;
    })().finally(() => this.reading.delete(agentId));
    this.reading.set(agentId, run);
    return run;
  }

  async stats(agentId: string): Promise<Stats> {
    this.agents.get(agentId); // 404 for an unknown agent
    const log = await this.log(agentId);
    const state = this.agents.status(agentId).state;
    return statsOf(
      log,
      Date.now(),
      state === 'working' || state === 'waiting-permission',
      // what a person said beside the work is a message too; a turn or a steer from the chat pane is in the log already
      this.chat
        .all(agentId)
        .filter(
          (m) => m.from === 'person' && m.via !== 'turn' && m.via !== 'steer',
        )
        .map((m) => ({ at: m.at, by: m.author })),
    );
  }
}
