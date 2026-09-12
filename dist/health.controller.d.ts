import { DaemonClient } from './daemon/daemon-client.js';
export declare class HealthController {
    private readonly daemon;
    constructor(daemon: DaemonClient);
    health(): {
        status: 'ok';
        daemon: boolean;
    };
}
