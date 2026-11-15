import Database from 'better-sqlite3';
import type { AgentsService } from '../agents/agents.service.js';
import type { AdaptersService } from '../adapters/adapters.service.js';
import type { ChatService } from '../chat/chat.service.js';
import type { ManagerConfig } from '../config/config.js';
import type { DbService } from '../db/db.service.js';
import { DialogService } from './dialog.service.js';

/**
 * The budget of a hand-back is a share of the agent's context window,
 * and the window is not always in the status: a Claude session on a
 * model name without `[1m]` states it only when a turn ends, so a
 * session just restarted has none. The first real hand-backs fell back
 * to 200K there, for an agent with a 1M window.
 */
describe('DialogService: the window the budget is a share of', () => {
  function service() {
    const db = new Database(':memory:');
    db.exec(
      'CREATE TABLE dialog_windows (agent_id TEXT PRIMARY KEY, size INTEGER NOT NULL); CREATE TABLE dialog_weights (agent_id TEXT, n INTEGER, kind TEXT, weight INTEGER, in_force INTEGER, superseded_by INTEGER, line TEXT, classified_at INTEGER, model TEXT)',
    );
    let status: unknown = { usage: null };
    const listeners = new Map<string, (...a: any[]) => void>();
    const agents = {
      on: (ev: string, fn: (...a: any[]) => void) => listeners.set(ev, fn),
      get: () => ({ id: 'a', profile: 'claude', host: null, archivedAt: null }),
      status: () => status,
      itemCount: () => 0,
      items: async () => ({ items: [], total: 0 }),
    };
    const make = () => {
      const s = new DialogService(
        { dialogBudget: 0.1, dialogClassifier: null } as ManagerConfig,
        { db } as unknown as DbService,
        agents as unknown as AgentsService,
        { all: () => [] } as unknown as ChatService,
        {} as AdaptersService,
      );
      s.onModuleInit();
      return s;
    };
    return {
      make,
      say: (s: unknown) => {
        status = s;
        listeners.get('state')!('a', 'p', s);
      },
      forget: () => (status = { usage: null }),
    };
  }

  it('is what the agent last reported, across a session that has not said yet and a restart of the manager', async () => {
    const t = service();
    const first = t.make();
    // never reported, a Claude agent: its vendor's usual window, 1M
    expect((await first.preview('a')).budget).toBe(100_000);
    // this one turns out to have the small one
    t.say({ usage: { context: { used: 90_000, size: 200_000 } } });
    expect((await first.preview('a')).budget).toBe(20_000);
    // the agent was restarted: its new session has not reported a window
    t.forget();
    expect((await first.preview('a')).budget).toBe(20_000);
    // and so was the manager
    expect((await t.make().preview('a')).budget).toBe(20_000);
  });
});
