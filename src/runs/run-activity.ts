import { MANAGER_AUTHOR, type StoredItem } from '../agents/agents.service.js';

/**
 * When the agent last did something of its own, from a tail of its
 * transcript; null when it did nothing of its own in that tail.
 *
 * "Of its own" is the point. A run's idle clock cannot read the agent's
 * last activity as such, because the manager pokes an idle agent with
 * background jobs every half hour and the agent answers: text, a turn
 * end, and a clock reset, for as long as the jobs stay pending. So the
 * whole turn a poke opens is not the agent's own work — not only the
 * message at its head — and neither is a message anyone else sent, nor
 * the manager's own lines about sessions beginning and ending.
 *
 * What counts is what the agent produced when it was not answering the
 * manager: its text, its thinking, its tool calls and their results, an
 * error, a permission it asked for, and the end of a turn it took.
 */
export function lastOwnActivity(items: StoredItem[]): number | null {
  let inPoke = false;
  let last: number | null = null;
  for (const stored of items) {
    const item = stored.item;
    if (item.kind === 'user') {
      // A poke opens a turn that is the manager's, not the agent's; any
      // other message is someone else's and is not the agent working either.
      inPoke = item.by === MANAGER_AUTHOR;
      continue;
    }
    if (item.kind === 'turn_end') {
      if (inPoke) {
        inPoke = false; // the poke's turn is over; what follows is the agent's again
        continue;
      }
      last = stored.at;
      continue;
    }
    if (inPoke) continue;
    if (item.kind === 'system') continue; // the harness narrating, not the agent
    last = stored.at;
  }
  return last;
}
