import { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { DaemonError } from './daemon-client.js';
export declare class DaemonErrorFilter implements ExceptionFilter {
    catch(err: DaemonError, host: ArgumentsHost): void;
}
