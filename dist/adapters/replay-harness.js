import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../test/fixtures');
export function loadFixture(vendor, name) {
    return fs
        .readFileSync(path.join(FIXTURES, vendor, name), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
}
export function replay(adapter, records) {
    const items = [];
    const keys = new Map();
    const states = [];
    const sent = [];
    let conversationId;
    let error;
    for (const r of records) {
        const ing = adapter.ingest(r);
        if (ing.conversationId)
            conversationId = ing.conversationId;
        for (const op of ing.ops ?? []) {
            if (op.op === 'update' && keys.has(op.key)) {
                items[keys.get(op.key)] = op.item;
                continue;
            }
            items.push(op.item);
            if (op.key)
                keys.set(op.key, items.length - 1);
        }
        for (const line of ing.send ?? [])
            sent.push({ afterSeq: r.seq, line });
        if (ing.state)
            states.push(ing.state);
        if (ing.error)
            error = ing.error;
    }
    return { items, states, sent, conversationId, error };
}
//# sourceMappingURL=replay-harness.js.map