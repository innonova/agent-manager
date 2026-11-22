import { spawn } from 'node:child_process';

/**
 * One model call of the manager's own: a command (an agent CLI, headless,
 * with no tools) that gets its input on stdin and answers on stdout.
 * None of a session's identity goes with it: the `AGENT_MANAGER_*`
 * variables are an agent's, and this is not one.
 */
export function runModel(
  argv: string[],
  input: string,
  opts: { cwd: string; timeoutMs: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const k of Object.keys(env))
      if (k.startsWith('AGENT_MANAGER_') || k === 'ELECTRON_RUN_AS_NODE')
        delete env[k];
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('the model call took too long'));
    }, opts.timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      if (err.length < 4000) err += d;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else
        reject(
          new Error(
            `the model command exited ${code}: ${err.trim().slice(0, 300) || out.trim().slice(0, 300)}`,
          ),
        );
    });
    child.stdin.on('error', () => undefined); // a command that exits early: its exit code says why
    child.stdin.end(input);
  });
}
