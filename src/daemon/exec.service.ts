import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DaemonClients } from './daemon-clients.js';
import { DaemonError } from './daemon-client.js';
import type { DaemonSession, LogRecord } from './daemon-client.js';

export interface ExecResult {
  host: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** The command was still running at the deadline and was killed; the output is what came before. */
  timedOut: boolean;
}

/** The profile every daemon carries for this: a shell that takes one command as its argument (bash -lc; PowerShell -Command). */
export const SHELL_PROFILE = 'shell';
const MAX_TIMEOUT_MS = 60 * 60_000;

/**
 * One command on one host, through that host's daemon: a one-shot session
 * of the `shell` profile with the command as its argument, its output
 * collected until it exits, the session then removed. What this gives
 * over ssh is the session: the daemon runs where the user is logged on,
 * so on Windows the command sees the desktop, which an ssh login does
 * not. For an agent it is one call with the output back, not a
 * conversation with another agent about running something.
 */
@Injectable()
export class ExecService {
  private readonly logger = new Logger(ExecService.name);

  constructor(private readonly daemons: DaemonClients) {}

  async run(
    host: string,
    input: { command?: unknown; cwd?: unknown; timeoutMs?: unknown },
  ): Promise<ExecResult> {
    const daemon = this.daemons.for(host);
    if (!daemon) throw new NotFoundException(`no host ${host}`);
    if (typeof input.command !== 'string' || !input.command.trim())
      throw new BadRequestException('"command" is required');
    if (input.cwd !== undefined && typeof input.cwd !== 'string')
      throw new BadRequestException('"cwd" must be a string');
    const timeoutMs =
      input.timeoutMs === undefined
        ? 10 * 60_000
        : Math.min(
            MAX_TIMEOUT_MS,
            Math.max(1000, Number(input.timeoutMs) || 0),
          );
    const started = Date.now();
    let session: DaemonSession;
    try {
      session = await daemon.start({
        profile: SHELL_PROFILE,
        args: [input.command],
        ...(input.cwd ? { cwd: input.cwd } : {}),
        label: 'exec',
      });
    } catch (err) {
      if (err instanceof DaemonError && /profile/i.test(err.message))
        throw new BadRequestException(
          `${host} has no "${SHELL_PROFILE}" profile; the daemon's installer writes one`,
        );
      throw err;
    }
    const id = session.id;
    const out: string[] = [];
    const errOut: string[] = [];
    let exited: DaemonSession | null = null;
    let resolveExit: () => void = () => undefined;
    const exit = new Promise<void>((r) => (resolveExit = r));
    const onOutput = (h: string, sid: string, rec: LogRecord) => {
      if (sid !== id) return;
      if (rec.s === 'out') out.push(rec.d);
      else if (rec.s === 'err') errOut.push(rec.d);
    };
    const onChanged = (h: string, s: DaemonSession) => {
      if (s.id !== id) return;
      if (s.state === 'exited') {
        exited = s;
        resolveExit();
      }
    };
    this.daemons.on('output', onOutput);
    this.daemons.on('changed', onChanged);
    let timedOut = false;
    try {
      await daemon.attach(id, 1); // everything from the first record: output may have come before the attach
      const fresh = await daemon.getSession(id); // exited before the attach is a changed frame we may have missed
      if (fresh.state === 'exited') {
        exited = fresh;
        resolveExit();
      }
      const timer = setTimeout(() => {
        timedOut = true;
        void daemon.signal(id, 'SIGKILL').catch(() => undefined);
      }, timeoutMs);
      await exit;
      clearTimeout(timer);
    } finally {
      this.daemons.off('output', onOutput);
      this.daemons.off('changed', onChanged);
      await daemon
        .remove(id)
        .catch((err: Error) =>
          this.logger.warn(`exec session ${id} not removed: ${err.message}`),
        );
    }
    const s = exited as DaemonSession | null;
    return {
      host,
      exitCode: s?.exitCode ?? null,
      signal: s?.signal ?? null,
      stdout: out.join('\n') + (out.length ? '\n' : ''),
      stderr: errOut.join('\n') + (errOut.length ? '\n' : ''),
      durationMs: Date.now() - started,
      timedOut,
    };
  }
}
