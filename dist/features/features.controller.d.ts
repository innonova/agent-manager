import { Feature, FeaturesService } from './features.service.js';
export declare class FeaturesController {
    private readonly features;
    constructor(features: FeaturesService);
    list(id: string): Promise<{
        features: Feature[];
    }>;
    create(id: string, body: Record<string, unknown>): Promise<{
        feature: Feature;
    }>;
    get(id: string, slug: string): Promise<{
        feature: Feature;
    }>;
    patch(id: string, slug: string, body: {
        status?: unknown;
    }): Promise<{
        feature: Feature;
    }>;
    queue(id: string, slug: string, body: {
        agentId?: unknown;
    }): Promise<{
        feature: Feature;
    }>;
    dequeue(id: string, slug: string): Promise<{
        feature: Feature;
    }>;
}
