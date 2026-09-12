import os from 'node:os';
import path from 'node:path';
export const MANAGER_CONFIG = Symbol('MANAGER_CONFIG');
export function loadConfig(env = process.env) {
    const listen = env.AGENT_MANAGER_LISTEN ?? '0.0.0.0:4268';
    const idx = listen.lastIndexOf(':');
    const host = idx >= 0 ? listen.slice(0, idx) : '0.0.0.0';
    const port = Number(idx >= 0 ? listen.slice(idx + 1) : listen);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`AGENT_MANAGER_LISTEN has an invalid port: ${listen}`);
    }
    const xdgState = env.XDG_STATE_HOME && env.XDG_STATE_HOME.length > 0
        ? env.XDG_STATE_HOME
        : path.join(os.homedir(), '.local/state');
    return {
        host: host || '0.0.0.0',
        port,
        daemonUrl: env.AGENT_MANAGER_DAEMON_URL ?? 'ws://127.0.0.1:4267/',
        dataDir: env.AGENT_MANAGER_DATA_DIR ?? path.join(xdgState, 'agent-manager'),
        uiDir: env.AGENT_MANAGER_UI_DIR ?? null,
        adminPassword: env.AGENT_MANAGER_ADMIN_PASSWORD || null,
        secureCookie: env.AGENT_MANAGER_SECURE_COOKIE === '1',
        sessionTtlMs: Number(env.AGENT_MANAGER_SESSION_TTL_MS ?? 30 * 24 * 3600 * 1000),
    };
}
//# sourceMappingURL=config.js.map