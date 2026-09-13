import type { NextFunction, Request, Response } from 'express';
import type { AuthService } from '../auth/auth.service.js';
import { REMOTE_ID_RE, type HubService } from './hub.service.js';

const PREFIXED = /^\/api\/(projects|agents)\/([^/]+)(\/.*)?$/;

/**
 * Forwards requests about a spoke's project or agent (ids `<spoke>:<id>`)
 * to that spoke, as the user making the request. Everything else falls
 * through to this manager's own routes.
 */
export function hubProxy(hub: HubService, auth: AuthService) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    if (!hub.enabled) return next();
    const m = PREFIXED.exec(req.baseUrl + req.path); // mounted under /api: req.path is relative to it;
    if (!m) return next();
    let target: ReturnType<HubService['split']>;
    try {
      target = hub.split(decodeURIComponent(m[2]!));
    } catch {
      return next();
    }
    if (!target) return next();
    // Never anything that could leave the spoke's project/agent routes:
    // the id must be plain, and every segment after it a plain name (no
    // `.`/`..`, nothing percent-encoded that a URL parser would fold).
    const rest = m[3] ?? '';
    const restOk = rest
      .split('/')
      .slice(1)
      .every((seg) =>
        /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/.test(seg),
      );
    if (!REMOTE_ID_RE.test(target.id) || !restOk) {
      res.status(404).json({ statusCode: 404, message: 'no such id' });
      return;
    }
    const { user } = auth.userForHeaders(req.headers);
    if (!user) {
      res.status(401).json({ statusCode: 401, message: 'Unauthorized' });
      return;
    }
    const query = req.url.includes('?')
      ? req.url.slice(req.url.indexOf('?'))
      : '';
    const apiPath = `/api/${m[1]}/${encodeURIComponent(target.id)}${m[3] ?? ''}${query}`;
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    try {
      const r = Buffer.isBuffer(req.body)
        ? await hub.callRaw(
            target.spoke,
            req.method,
            apiPath,
            user.name,
            req.body,
            String(req.headers['content-type'] ?? 'application/octet-stream'),
          )
        : await hub.call(
            target.spoke,
            req.method,
            apiPath,
            user.name,
            mutating ? (req.body ?? {}) : undefined,
          );
      res.status(r.status).json(r.body);
    } catch (err) {
      res.status(502).json({
        statusCode: 502,
        message: `${target.spoke.name} is not reachable: ${(err as Error).message}`,
        code: 'spoke-unreachable',
      });
    }
  };
}
