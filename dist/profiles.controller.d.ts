import { AdaptersService } from './adapters/adapters.service.js';
import { DaemonClient, DaemonProfile } from './daemon/daemon-client.js';
export declare class ProfilesController {
    private readonly daemon;
    private readonly adapters;
    constructor(daemon: DaemonClient, adapters: AdaptersService);
    list(): Promise<{
        profiles: (DaemonProfile & {
            supported: boolean;
        })[];
    }>;
}
