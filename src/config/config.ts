import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ManagerConfig {
  host: string;
  port: number;
  daemonUrl: string;
  dataDir: string;
  /** Directory with the built UI to serve at `/`; null disables. Defaults to `<install>/ui` next to `dist/`. */
  uiDir: string | null;
  /** The origin browsers use to reach the manager (behind TLS: https://...). Enables Secure cookies and is accepted by the origin check. */
  publicOrigin: string | null;
  adminPassword: string | null;
  secureCookie: boolean;
  /** Milliseconds a login session lives. */
  sessionTtlMs: number;
  /** Login attempts allowed per client address per minute. */
  loginAttemptsPerMinute: number;
  /** Reverse proxies whose X-Forwarded-For is trusted (express trust proxy values). */
  trustedProxies: string[];
  /** Interval of websocket pings on /api/events; keeps idle sockets alive through proxies. */
  eventsPingMs: number;
  /** An agent idle with background jobs and no activity this long is asked to check on them; 0 disables. */
  backgroundPokeMs: number;
  /** Transcript items kept in memory per agent beyond what the transcript cache holds. */
  residentItems: number;
  /** How this machine is named to the UI, and by a hub that fronts for it. */
  hostName: string;
  /** Accepted as a bearer token by another manager acting as a hub; null means no hub may. */
  hubToken: string | null;
  /** The spokes this manager fronts for, `[{ name, url, token }]`; absent means not a hub. */
  spokesFile: string;
  /** The harness note's template, given to every agent at session start; absent means the shipped one, empty means none. */
  harnessFile: string;
  /** The template as shipped: `harness.md` next to `dist/`; what the installer seeds the config file from. */
  shippedHarnessFile: string;
  /** The house view of the models, rendered into every note at `{{models}}`; absent means the shipped one, empty means none. */
  modelsFile: string;
  /** The models file as shipped: `models.md` next to `dist/`; what the installer seeds the config file from. */
  shippedModelsFile: string;
}

export const MANAGER_CONFIG = Symbol('MANAGER_CONFIG');

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): ManagerConfig {
  const listen = env.AGENT_MANAGER_LISTEN ?? '0.0.0.0:4268';
  const idx = listen.lastIndexOf(':');
  const host = idx >= 0 ? listen.slice(0, idx) : '0.0.0.0';
  const port = Number(idx >= 0 ? listen.slice(idx + 1) : listen);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`AGENT_MANAGER_LISTEN has an invalid port: ${listen}`);
  }
  const xdgState =
    env.XDG_STATE_HOME && env.XDG_STATE_HOME.length > 0
      ? env.XDG_STATE_HOME
      : path.join(os.homedir(), '.local/state');
  const xdgConfig =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : path.join(os.homedir(), '.config');
  return {
    host: host || '0.0.0.0',
    port,
    daemonUrl: env.AGENT_MANAGER_DAEMON_URL ?? 'ws://127.0.0.1:4267/',
    dataDir: env.AGENT_MANAGER_DATA_DIR ?? path.join(xdgState, 'agent-manager'),
    uiDir:
      env.AGENT_MANAGER_UI_DIR === ''
        ? null
        : (env.AGENT_MANAGER_UI_DIR ??
          path.resolve(
            path.dirname(fileURLToPath(import.meta.url)),
            '..',
            '..',
            'ui',
          )),
    publicOrigin: env.AGENT_MANAGER_PUBLIC_ORIGIN?.replace(/\/$/, '') || null,
    adminPassword: env.AGENT_MANAGER_ADMIN_PASSWORD || null,
    secureCookie:
      env.AGENT_MANAGER_SECURE_COOKIE === '1' ||
      (env.AGENT_MANAGER_PUBLIC_ORIGIN ?? '').startsWith('https://'),
    sessionTtlMs: Number(
      env.AGENT_MANAGER_SESSION_TTL_MS ?? 30 * 24 * 3600 * 1000,
    ),
    loginAttemptsPerMinute: Number(
      env.AGENT_MANAGER_LOGIN_ATTEMPTS_PER_MINUTE ?? 10,
    ),
    trustedProxies: (env.AGENT_MANAGER_TRUSTED_PROXIES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    eventsPingMs: Number(env.AGENT_MANAGER_EVENTS_PING_MS ?? 25_000),
    backgroundPokeMs: Number(
      env.AGENT_MANAGER_BACKGROUND_POKE_MS ?? 30 * 60_000,
    ),
    residentItems: Number(env.AGENT_MANAGER_RESIDENT_ITEMS ?? 500),
    hostName:
      env.AGENT_MANAGER_HOST_NAME || os.hostname().split('.')[0] || 'local',
    hubToken: env.AGENT_MANAGER_HUB_TOKEN || null,
    spokesFile:
      env.AGENT_MANAGER_SPOKES_FILE ??
      path.join(
        env.AGENT_MANAGER_DATA_DIR ?? path.join(xdgState, 'agent-manager'),
        'spokes.json',
      ),
    harnessFile:
      env.AGENT_MANAGER_HARNESS_FILE ??
      path.join(xdgConfig, 'agent-manager', 'harness.md'),
    shippedHarnessFile: path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'harness.md',
    ),
    modelsFile:
      env.AGENT_MANAGER_MODELS_FILE ??
      path.join(xdgConfig, 'agent-manager', 'models.md'),
    shippedModelsFile: path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'models.md',
    ),
  };
}
