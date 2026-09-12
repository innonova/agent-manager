export interface ManagerConfig {
    host: string;
    port: number;
    daemonUrl: string;
    dataDir: string;
    uiDir: string | null;
    publicOrigin: string | null;
    adminPassword: string | null;
    secureCookie: boolean;
    sessionTtlMs: number;
    loginAttemptsPerMinute: number;
}
export declare const MANAGER_CONFIG: unique symbol;
export declare function loadConfig(env?: NodeJS.ProcessEnv): ManagerConfig;
