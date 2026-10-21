import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'clock-hook.mjs',
);

/** Runs the hook as Claude would: the event on stdin, the answer on stdout. */
function run(event: unknown, every: number, stateDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [HOOK, '--every', String(every)],
      { env: { ...process.env, AGENT_MANAGER_CLOCK_STATE_DIR: stateDir } },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
    child.stdin!.end(JSON.stringify(event));
  });
}

describe('clock hook', () => {
  it('tells the time on the first call of a session, then at most once per interval', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clock-'));
    const first = await run(
      { session_id: 's1', hook_event_name: 'PostToolUse' },
      60_000,
      dir,
    );
    const parsed = JSON.parse(first);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(
      /^The time is \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(.+\)\.$/,
    );
    // within the interval: silence
    expect(await run({ session_id: 's1' }, 60_000, dir)).toBe('');
    // another session has its own clock
    expect(await run({ session_id: 's2' }, 60_000, dir)).not.toBe('');
    // the interval passed (a stamp from long ago): it speaks again
    fs.writeFileSync(
      path.join(dir, 'am-clock-s1'),
      String(Date.now() - 61_000),
    );
    expect(await run({ session_id: 's1' }, 60_000, dir)).not.toBe('');
    // 0 turns it off
    expect(await run({ session_id: 's3' }, 0, dir)).toBe('');
  });
});
