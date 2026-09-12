export interface ManagerConfig {
    host: string;
    port: number;
    daemonUrl: string;
    dataDir: string;
    uiDir: string | null;
    adminPassword: string | null;
    secureCookie: boolean;
    sessionTtlMs: number;
}
export declare const MANAGER_CONFIG: unique symbol;
export declare function loadConfig(env?: NodeJS.ProcessEnv): ManagerConfig;
