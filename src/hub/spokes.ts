import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '@nestjs/common';

/** One remote manager this one fronts for. */
export interface Spoke {
  name: string;
  url: string;
  token: string;
  /** What the machine is and is for, in a phrase: told to every agent, so one that could use it knows it exists. */
  description?: string;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/; // a host name, as hub.service checks it

/**
 * The spokes this manager fronts for, from `spokes.json` (name, url,
 * token): read by the hub for its calls and by the daemon clients for
 * the tunnel to each spoke's daemon. The file holds credentials, so one
 * readable by other users is ignored with an error.
 */
export function loadSpokes(
  file: string,
  localName: string,
  logger: Logger,
): Spoke[] {
  let raw: string;
  try {
    const st = fs.statSync(file);
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
      logger.error(
        `${file} is readable by other users; chmod 600 it (the spokes are ignored until then)`,
      );
      return [];
    }
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    logger.error(`${path.basename(file)} ignored: not valid JSON`); // never the parser's message: it quotes the text
    return [];
  }
  try {
    if (!Array.isArray(list)) throw new Error('not a list');
    const out: Spoke[] = [];
    for (const [i, s] of (list as Record<string, unknown>[]).entries()) {
      const name = String(s?.name ?? '');
      const url = String(s?.url ?? '');
      const token = String(s?.token ?? '');
      if (!NAME_RE.test(name)) throw new Error(`entry ${i + 1}: bad name`);
      if (name === localName)
        throw new Error(
          `entry ${i + 1} (${name}): a spoke cannot be named like this machine (AGENT_MANAGER_HOST_NAME)`,
        );
      if (out.some((o) => o.name === name))
        throw new Error(`entry ${i + 1} (${name}): the name repeats`);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error(`entry ${i + 1} (${name}): bad url`);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        throw new Error(`entry ${i + 1} (${name}): url must be http(s)`);
      if (!token) throw new Error(`entry ${i + 1} (${name}): no token`);
      const description =
        typeof s?.description === 'string' && s.description.trim()
          ? s.description.trim().slice(0, 200)
          : undefined;
      out.push({
        name,
        url: parsed.origin + parsed.pathname.replace(/\/$/, ''),
        token,
        ...(description ? { description } : {}),
      });
    }
    return out;
  } catch (err) {
    logger.error(`${path.basename(file)} ignored: ${(err as Error).message}`);
    return [];
  }
}
