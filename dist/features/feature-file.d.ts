export declare const FEATURE_STATUSES: readonly ["planned", "queued", "in-progress", "review", "blocked", "done"];
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];
export interface FeatureFile {
    slug: string;
    path: string;
    title: string;
    status: FeatureStatus;
    priority: number;
    profile: string | null;
    dependsOn: string[];
    body: string;
    extra: Record<string, unknown>;
    mtime: number;
}
export declare const FEATURES_DIR = "features";
export declare function isSlug(s: unknown): s is string;
export declare function parseFeature(slug: string, filePath: string, text: string, mtime: number): FeatureFile;
export declare function serializeFeature(f: Pick<FeatureFile, 'title' | 'status' | 'priority' | 'profile' | 'dependsOn' | 'body' | 'extra'>): string;
export declare function readFeatures(projectRoot: string): Promise<FeatureFile[]>;
export declare function readFeature(projectRoot: string, slug: string): Promise<FeatureFile | null>;
export declare function writeFeature(projectRoot: string, f: FeatureFile): Promise<void>;
