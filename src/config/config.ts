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
  /** A run whose agent has done nothing for this long is closed as abandoned; 0 disables. */
  runIdleMs: number;
  /** Transcript items kept in memory per agent beyond what the transcript cache holds. */
  residentItems: number;
  /** How this machine is named to the UI, and by a hub that fronts for it. */
  hostName: string;
  /** How a person's own machine reaches this one over SSH (`host` or `user@host`), for the links that open a project in an editor. */
  sshHost: string;
  /** Where the projects' VS Code workspace files go; null means beside each project's repositories. */
  workspacesDir: string | null;
  /** Where streams live: each stream's home is a directory here (see `docs/streams.md`). */
  streamsDir: string;
  /** The store: one git repository with a folder per stream. Beneath the streams directory unless set apart. */
  storeDir: string;
  /** How often the manager commits what changed in the store (ms); 0 never. */
  storeCommitMs: number;
  /** The address an agent on another machine reaches this manager at (its `AGENT_MANAGER_URL`); null means the listening address, which is right for local agents only. */
  agentUrl: string | null;
  /** How often, at most, a Claude agent is told the time beside a tool result (ms); 0 never. */
  clockMs: number;
  /** The hook script that does it, shipped beside the fake agent. */
  clockHook: string;
  /** The hook script that hands a Claude agent its dialog back after a compaction, shipped beside the clock's. */
  handbackHook: string;
  /**
   * The command that weighs an agent's dialog, as an argument list: it
   * gets the instructions and the dialog on stdin and answers on stdout.
   * Null means nothing is weighed and only the recent dialog is handed
   * back whole. `AGENT_MANAGER_DIALOG_CLASSIFIER_MODEL` names the model
   * of the default command (`off` for none);
   * `AGENT_MANAGER_DIALOG_CLASSIFIER` replaces the command, as a JSON
   * array.
   */
  dialogClassifier: string[] | null;
  /** How long one weighing may take (ms). */
  dialogClassifierMs: number;
  /** The share of its context window an agent's dialog is weighed at, ahead of the compaction. */
  dialogClassifyAt: number;
  /** The share of the context window the handed-back dialog may take. */
  dialogBudget: number;
  /** How long a hand-back waits for a weighing under way (ms). */
  dialogWaitMs: number;
  /**
   * The command that reads an agent's last message when it stops, for
   * agents with `nudge` on: the instructions and the message on stdin,
   * one line of JSON back. Null: nobody is nudged.
   * `AGENT_MANAGER_NUDGE_MODEL` names the model of the default command
   * (`off` for none); `AGENT_MANAGER_NUDGE_READER` replaces the command,
   * as a JSON array.
   */
  nudgeReader: string[] | null;
  /** How long one reading may take (ms). */
  nudgeReaderMs: number;
  /** How long after a stop the nudge goes, the time a person has to say something first (ms). */
  nudgeDelayMs: number;
  /** An agent is nudged again only after this much work since the last nudge (ms). */
  nudgeWorkMs: number;
  /** No more than this many nudges in a row without a word from a person. */
  nudgeMaxInRow: number;
  /** While a working agent has unread chat messages it is told so again this often (ms). */
  chatRepeatMs: number;
  /** How often the chat looks for messages a state change did not deliver (ms). */
  chatSweepMs: number;
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
  /** The method: how work is run under this manager, for every project on the machine. */
  methodFile: string;
  /** The method as shipped: `method.md` next to `dist/`. */
  shippedMethodFile: string;
  /** The framing: how to write a feature and a brief, the method's companion. */
  framingFile: string;
  /** The framing as shipped: `framing.md` next to `dist/`. */
  shippedFramingFile: string;
}

export const MANAGER_CONFIG = Symbol('MANAGER_CONFIG');

/**
 * The base of state (data, cache, spokes) and config (the four operator
 * texts): the XDG dirs on Linux and macOS, and on Windows the profile's
 * Local and Roaming AppData, where a per-user service keeps its files.
 */
export function baseDir(
  env: NodeJS.ProcessEnv,
  kind: 'config' | 'state',
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32')
    return kind === 'config'
      ? env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
      : env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const xdg = kind === 'config' ? env.XDG_CONFIG_HOME : env.XDG_STATE_HOME;
  if (xdg && xdg.length > 0) return xdg;
  return path.join(
    os.homedir(),
    kind === 'config' ? '.config' : '.local/state',
  );
}

/**
 * The command that weighs a dialog. By default Claude Code, headless,
 * with no tools and a system prompt of one line (the instructions come
 * with the dialog, on stdin), on the strongest model: tried on this
 * project's own dialog, Fable and Opus kept the exchanges that hold a
 * reason or a rule, where Sonnet kept reports of finished work and
 * Haiku too little (learnings, 2026-11-15). One weighing costs a few
 * dollars and happens about once per context window.
 */
function dialogClassifier(env: NodeJS.ProcessEnv): string[] | null {
  return modelCommand(
    env.AGENT_MANAGER_DIALOG_CLASSIFIER,
    env.AGENT_MANAGER_DIALOG_CLASSIFIER_MODEL ?? 'fable[1m]',
    'AGENT_MANAGER_DIALOG_CLASSIFIER',
    'You weigh the exchanges of a dialog exactly as the instructions at the top of the input say. Output only the JSON lines they ask for.',
  );
}

/**
 * A model call of the manager's own as a command: the whole command
 * when one is given (a JSON array; `off` or empty for none), else
 * Claude Code, headless, with no tools, on the model named (`off` or
 * empty for none) and a system prompt of one line: the instructions
 * come with the input, on stdin.
 */
function modelCommand(
  whole: string | undefined,
  model: string,
  name: string,
  system: string,
): string[] | null {
  if (whole !== undefined) {
    if (!whole || whole === 'off') return null;
    try {
      const argv: unknown = JSON.parse(whole);
      if (
        Array.isArray(argv) &&
        argv.length > 0 &&
        argv.every((a) => typeof a === 'string')
      )
        return argv as string[];
    } catch {
      /* said below */
    }
    throw new Error(
      `${name} must be a JSON array of strings (the command and its arguments), or "off"`,
    );
  }
  if (!model || model === 'off') return null;
  return [
    'claude',
    '-p',
    '--model',
    model,
    '--tools',
    '',
    '--no-session-persistence',
    '--output-format',
    'text',
    '--system-prompt',
    system,
  ];
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ManagerConfig {
  const listen = env.AGENT_MANAGER_LISTEN ?? '0.0.0.0:4268';
  const idx = listen.lastIndexOf(':');
  const host = idx >= 0 ? listen.slice(0, idx) : '0.0.0.0';
  const port = Number(idx >= 0 ? listen.slice(idx + 1) : listen);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`AGENT_MANAGER_LISTEN has an invalid port: ${listen}`);
  }
  const xdgState = baseDir(env, 'state', platform);
  const streamsDir =
    env.AGENT_MANAGER_STREAMS_DIR || path.join(os.homedir(), 'streams');
  const xdgConfig = baseDir(env, 'config', platform);
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
    sshHost:
      env.AGENT_MANAGER_SSH_HOST ||
      env.AGENT_MANAGER_HOST_NAME ||
      os.hostname().split('.')[0] ||
      'local',
    workspacesDir: env.AGENT_MANAGER_WORKSPACES_DIR || null,
    streamsDir,
    storeDir: env.AGENT_MANAGER_STORE_DIR || path.join(streamsDir, '.store'),
    storeCommitMs: Number(env.AGENT_MANAGER_STORE_COMMIT_MS ?? 30_000),
    agentUrl: env.AGENT_MANAGER_AGENT_URL?.replace(/\/$/, '') || null,
    clockMs: Number(env.AGENT_MANAGER_CLOCK_MS ?? 10 * 60_000),
    clockHook: path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'fixtures',
      'clock-hook.mjs',
    ),
    handbackHook: path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'fixtures',
      'handback-hook.mjs',
    ),
    dialogClassifier: dialogClassifier(env),
    dialogClassifierMs: Number(
      env.AGENT_MANAGER_DIALOG_CLASSIFIER_MS ?? 15 * 60_000,
    ),
    dialogClassifyAt: Number(env.AGENT_MANAGER_DIALOG_CLASSIFY_AT ?? 0.7),
    dialogBudget: Number(env.AGENT_MANAGER_DIALOG_BUDGET ?? 0.1),
    dialogWaitMs: Number(env.AGENT_MANAGER_DIALOG_WAIT_MS ?? 150_000),
    nudgeReader: modelCommand(
      env.AGENT_MANAGER_NUDGE_READER,
      env.AGENT_MANAGER_NUDGE_MODEL ?? 'claude-sonnet-5-5',
      'AGENT_MANAGER_NUDGE_READER',
      'You read one message and answer exactly as the instructions say.',
    ),
    nudgeReaderMs: Number(env.AGENT_MANAGER_NUDGE_READER_MS ?? 90_000),
    nudgeDelayMs: Number(env.AGENT_MANAGER_NUDGE_DELAY_MS ?? 5 * 60_000),
    nudgeWorkMs: Number(env.AGENT_MANAGER_NUDGE_WORK_MS ?? 30 * 60_000),
    nudgeMaxInRow: Number(env.AGENT_MANAGER_NUDGE_MAX ?? 20),
    chatRepeatMs: Number(env.AGENT_MANAGER_CHAT_REPEAT_MS ?? 5 * 60_000),
    chatSweepMs: Number(env.AGENT_MANAGER_CHAT_SWEEP_MS ?? 15_000),
    hubToken: env.AGENT_MANAGER_HUB_TOKEN || null,
    spokesFile:
      env.AGENT_MANAGER_SPOKES_FILE ??
      path.join(
        env.AGENT_MANAGER_DATA_DIR ?? path.join(xdgState, 'agent-manager'),
        'spokes.json',
      ),
    runIdleMs: Number(env.AGENT_MANAGER_RUN_IDLE_MS ?? 2 * 60 * 60 * 1000),
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
    methodFile:
      env.AGENT_MANAGER_METHOD_FILE ??
      path.join(xdgConfig, 'agent-manager', 'method.md'),
    shippedMethodFile: path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'method.md',
    ),
    framingFile:
      env.AGENT_MANAGER_FRAMING_FILE ??
      path.join(xdgConfig, 'agent-manager', 'framing.md'),
    shippedFramingFile: path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'framing.md',
    ),
  };
}
