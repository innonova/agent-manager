import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CacheState,
  TranscriptCache,
  TRANSCRIPT_CACHE_VERSION,
} from './transcript-cache.js';
import type { StoredItem } from './agents.service.js';

const item = (index: number, text = `item ${index} ✓ ü`): StoredItem => ({
  index,
  sessionId: 's1',
  seqFrom: index + 1,
  seqTo: index + 1,
  at: 1000 + index,
  item: { kind: 'text', text, streaming: false },
});
const header = {
  version: TRANSCRIPT_CACHE_VERSION,
  sessions: {},
};

describe('TranscriptCache', () => {
  let dir: string;
  let cache: TranscriptCache;
  let state: CacheState;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-cache-'));
    cache = new TranscriptCache(dir);
    state = { count: 0, bytes: 0, offsets: [] };
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('appends in batches and reads any index range back, across the offset stride', async () => {
    const all = Array.from({ length: 700 }, (_, i) => item(i));
    await cache.append('a', state, all.slice(0, 300), header);
    await cache.append('a', state, all.slice(300, 300), header); // header only
    await cache.append('a', state, all.slice(300), header);
    expect(state.count).toBe(700);
    expect(state.offsets).toHaveLength(3); // items 0, 256, 512
    expect(await cache.read('a', state, 0, 3)).toEqual(all.slice(0, 3));
    expect(await cache.read('a', state, 250, 260)).toEqual(all.slice(250, 260));
    expect(await cache.read('a', state, 511, 513)).toEqual(all.slice(511, 513));
    expect(await cache.read('a', state, 690, 1000)).toEqual(all.slice(690));
    expect(await cache.read('a', state, 5, 5)).toEqual([]);
    const h = await cache.load('a');
    expect(h).toMatchObject({ count: 700, sessions: {} });
    expect(h!.bytes).toBe(
      fs.statSync(path.join(dir, 'transcripts/a.ndjson')).size,
    );
  });

  it('cuts a file back to what the header covers, and rejects a header for a missing or short file', async () => {
    await cache.append('a', state, [item(0), item(1)], header);
    const file = path.join(dir, 'transcripts/a.ndjson');
    fs.appendFileSync(file, JSON.stringify(item(2)) + '\n'); // a write that never got its header
    const h = await cache.load('a');
    expect(h!.count).toBe(2);
    expect(fs.statSync(file).size).toBe(h!.bytes);
    expect(await cache.read('a', h!, 0, 10)).toEqual([item(0), item(1)]);
    fs.truncateSync(file, 10);
    expect(await cache.load('a')).toBeNull();
    fs.rmSync(file);
    expect(await cache.load('a')).toBeNull();
  });

  it('ignores a header of another version, a corrupt one, and an absent one', async () => {
    expect(await cache.load('none')).toBeNull();
    await cache.append('a', state, [item(0)], header);
    const hp = path.join(dir, 'transcripts/a.json');
    fs.writeFileSync(
      hp,
      JSON.stringify({
        ...JSON.parse(fs.readFileSync(hp, 'utf8')),
        version: 0,
      }),
    );
    expect(await cache.load('a')).toBeNull();
    fs.writeFileSync(hp, '{not json');
    expect(await cache.load('a')).toBeNull();
    await cache.clear('a');
    expect(fs.existsSync(hp)).toBe(false);
  });
});
