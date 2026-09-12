import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { DaemonError } from './daemon-client.js';

/** A daemon problem is never the client's fault: 503 with the daemon's code and message. */
@Catch(DaemonError)
export class DaemonErrorFilter implements ExceptionFilter {
  catch(err: DaemonError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    res.status(503).json({
      statusCode: 503,
      code: 'agent-unavailable',
      daemonCode: err.code,
      message: `agent unavailable: ${err.message}`,
    });
  }
}
