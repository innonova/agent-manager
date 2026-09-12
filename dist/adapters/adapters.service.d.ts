import type { AgentAdapter } from './adapter.js';
export declare class AdaptersService {
    private readonly factories;
    supports(profile: string): boolean;
    create(profile: string): AgentAdapter;
    profiles(): string[];
}
