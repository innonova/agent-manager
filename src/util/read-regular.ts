import { constants as fsc } from 'node:fs';
import fs from 'node:fs/promises';

export class NotRegularFileError extends Error {}

/**
 * Reads a regular file, at most `max` bytes (+1 to know it overflowed),
 * with the descriptor's metadata from before and after the read so a
 * caller can tell whether the content it got is one coherent version.
 * Opened non-blocking so a FIFO cannot block a worker; checked after
 * opening so a device or a pipe is refused rather than read. Null when
 * the file is gone.
 */
export async function readRegular(
  abs: string,
  max: number,
): Promise<{
  buf: Buffer;
  truncated: boolean;
  /** mtime seen before the read and after it; equal when nothing wrote meanwhile. */
  mtimeBefore: number;
  mtimeAfter: number;
  size: number;
} | null> {
  let fh: fs.FileHandle;
  try {
    fh = await fs.open(abs, fsc.O_RDONLY | fsc.O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const before = await fh.stat();
    if (!before.isFile()) throw new NotRegularFileError('not a regular file');
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= max) {
      const chunk = Buffer.alloc(Math.min(65536, max + 1 - total));
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    const after = await fh.stat();
    const all = Buffer.concat(chunks);
    return {
      buf: all.subarray(0, Math.min(all.length, max)),
      truncated: all.length > max,
      mtimeBefore: before.mtimeMs,
      mtimeAfter: after.mtimeMs,
      size: after.size,
    };
  } finally {
    await fh.close();
  }
}
