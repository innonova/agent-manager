import type { NextFunction, Request, Response } from 'express';
import type { AuthService } from '../auth/auth.service.js';
import type { HubService } from './hub.service.js';

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
    const target = hub.split(decodeURIComponent(m[2]!));
    if (!target) return next();
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
      const r = await hub.call(
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
