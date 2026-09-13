import fs from 'node:fs/promises';
import path from 'node:path';
import type { AccountUsage } from '../adapters/adapter.js';
import type { AgentStatus, StoredItem } from './agents.service.js';

/** Bump when any adapter's normalised output changes; a mismatch rebuilds every agent from the log. */
export const TRANSCRIPT_CACHE_VERSION = 2;
/** One byte offset is kept per this many items, so a range read starts near its first item. */
const STRIDE = 256;

/** What the manager knows about the cache file between writes. */
export interface CacheState {
  /** Items in the file; also the index of the next item. */
  count: number;
  /** Bytes in the file. */
  bytes: number;
  /** Byte offset of item k*STRIDE, for k = 0.. */
  offsets: number[];
}

export interface CachedSession {
  /** Daemon sequence of the last record the cached items came from. */
  lastSeq: number;
  /** Agent-wide index one past the session's last cached item. */
  end: number;
  startedBoundary: boolean;
  endedBoundary: boolean;
  /** The adapter's cross-turn state at `lastSeq`, from its snapshot(). */
  adapter: unknown;
  /** The agent's status at that point, for the session that was current. */
  status: AgentStatus | null;
  /** The usage this session last reported, as the vendor gave it: its share of the agent's total. */
  usage: AccountUsage | null;
}

export interface CacheHeader extends CacheState {
  version: number;
  sessions: Record<string, CachedSession>;
}

/**
 * Materialised transcript items per agent, on disk under the data
 * directory: an NDJSON file of items in index order and a header with the
 * per-session state needed to continue from the last cached record. The
 * items file is only ever appended; the header is rewritten atomically
 * after each append, and a file longer than its header says is cut back
 * on load. Everything here can be regenerated from the daemon log, so a
 * corrupt or stale cache is simply dropped and rebuilt.
 */
export class TranscriptCache {
  constructor(private readonly root: string) {}

  private itemsPath(agentId: string): string {
    return path.join(this.root, 'transcripts', `${agentId}.ndjson`);
  }
  private headerPath(agentId: string): string {
    return path.join(this.root, 'transcripts', `${agentId}.json`);
  }

  /**
   * The header, if present and usable; the items file is cut to the
   * header's length. Anything unusable is removed, so a rebuild starts
   * from an empty file rather than appending to leftovers.
   */
  async load(agentId: string): Promise<CacheHeader | null> {
    const h = await this.readHeader(agentId);
    if (h) return h;
    await this.clear(agentId);
    return null;
  }

  private async readHeader(agentId: string): Promise<CacheHeader | null> {
    let h: CacheHeader;
    try {
      h = JSON.parse(
        await fs.readFile(this.headerPath(agentId), 'utf8'),
      ) as CacheHeader;
    } catch {
      return null;
    }
    if (
      h.version !== TRANSCRIPT_CACHE_VERSION ||
      !Number.isSafeInteger(h.count) ||
      !Array.isArray(h.offsets) ||
      typeof h.sessions !== 'object'
    )
      return null;
    try {
      const st = await fs.stat(this.itemsPath(agentId));
      if (st.size < h.bytes) return null;
      if (st.size > h.bytes)
        await fs.truncate(this.itemsPath(agentId), h.bytes);
    } catch {
      if (h.count > 0) return null;
    }
    return h;
  }

  /** Appends items with index `state.count`.. and rewrites the header; `state` is advanced on success. */
  async append(
    agentId: string,
    state: CacheState,
    items: StoredItem[],
    header: Omit<CacheHeader, keyof CacheState>,
  ): Promise<void> {
    await fs.mkdir(path.dirname(this.itemsPath(agentId)), { recursive: true });
    const size = await fs
      .stat(this.itemsPath(agentId))
      .then((st) => st.size)
      .catch(() => 0);
    if (size !== state.bytes)
      throw new Error(
        `cache file for ${agentId} is ${size} bytes, expected ${state.bytes}`,
      );
    const offsets = [...state.offsets];
    let bytes = state.bytes;
    const lines: string[] = [];
    for (const [i, it] of items.entries()) {
      if ((state.count + i) % STRIDE === 0) offsets.push(bytes);
      const line = JSON.stringify(it) + '\n';
      bytes += Buffer.byteLength(line);
      lines.push(line);
    }
    if (lines.length)
      await fs.appendFile(this.itemsPath(agentId), lines.join(''));
    const next: CacheState = {
      count: state.count + items.length,
      bytes,
      offsets,
    };
    const tmp = `${this.headerPath(agentId)}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ ...header, ...next }));
    await fs.rename(tmp, this.headerPath(agentId));
    Object.assign(state, next);
  }

  /** Cached items with index in [from, to). */
  async read(
    agentId: string,
    state: CacheState,
    from: number,
    to: number,
  ): Promise<StoredItem[]> {
    from = Math.max(0, from);
    to = Math.min(to, state.count);
    if (from >= to) return [];
    const block = Math.floor(from / STRIDE);
    let index = block * STRIDE;
    let pos = state.offsets[block] ?? 0;
    const out: StoredItem[] = [];
    const fh = await fs.open(this.itemsPath(agentId), 'r');
    try {
      // Lines are found by the newline byte in each chunk as it arrives; the
      // pieces of a line are only joined (and decoded) when the line is one
      // that was asked for, so a multi-megabyte item costs one pass, not one
      // per chunk.
      let parts: Buffer[] = [];
      while (index < to && pos < state.bytes) {
        const buf = Buffer.allocUnsafe(Math.min(64 * 1024, state.bytes - pos));
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (bytesRead === 0) break;
        pos += bytesRead;
        const chunk = buf.subarray(0, bytesRead);
        let start = 0;
        let nl: number;
        while (index < to && (nl = chunk.indexOf(0x0a, start)) >= 0) {
          if (index >= from) {
            const line = Buffer.concat([
              ...parts,
              chunk.subarray(start, nl),
            ]).toString('utf8');
            out.push(JSON.parse(line) as StoredItem);
          }
          parts = [];
          start = nl + 1;
          index++;
        }
        if (index < to && start < chunk.length) {
          // the tail of this chunk belongs to a line that continues; keep it only if that line is wanted
          if (index >= from) parts.push(Buffer.from(chunk.subarray(start)));
          else parts = [];
        }
      }
    } finally {
      await fh.close();
    }
    return out;
  }

  /** Forgets everything cached for an agent. */
  async clear(agentId: string): Promise<void> {
    await fs.rm(this.itemsPath(agentId), { force: true });
    await fs.rm(this.headerPath(agentId), { force: true });
  }
}
