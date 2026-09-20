import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentAdapter, AgentState, Ingest, Item } from './adapter.js';
import type { LogRecord } from '../daemon/daemon-client.js';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../test/fixtures',
);

export function loadFixture(vendor: string, name: string): LogRecord[] {
  return fs
    .readFileSync(path.join(FIXTURES, vendor, name), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as LogRecord);
}

/** The same reduction AgentsService applies, plus every line the adapter asked to send. */
export function replay(adapter: AgentAdapter, records: LogRecord[]) {
  const items: Item[] = [];
  const keys = new Map<string, number>();
  const states: AgentState[] = [];
  const backgrounds: number[] = [];
  const sent: { afterSeq: number; line: any }[] = [];
  const activities: Exclude<Ingest['activity'], undefined>[] = [];
  let conversationId: string | undefined;
  let error: string | undefined;
  for (const r of records) {
    const ing = adapter.ingest(r);
    if (ing.conversationId) conversationId = ing.conversationId;
    for (const op of ing.ops ?? []) {
      if (op.op === 'update' && keys.has(op.key)) {
        items[keys.get(op.key)!] = op.item;
        continue;
      }
      items.push(op.item);
      if (op.key) keys.set(op.key, items.length - 1);
    }
    for (const line of ing.send ?? []) sent.push({ afterSeq: r.seq, line });
    if (ing.state) states.push(ing.state);
    if (ing.background !== undefined) backgrounds.push(ing.background);
    if (ing.error) error = ing.error;
    if (ing.activity !== undefined) activities.push(ing.activity);
  }
  return {
    items,
    states,
    backgrounds,
    sent,
    conversationId,
    error,
    activities,
  };
}
