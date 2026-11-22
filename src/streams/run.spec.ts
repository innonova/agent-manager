import os from 'node:os';
import { run } from './streams.service.js';

const cwd = os.tmpdir();

describe("a command of the manager's own", () => {
  it('gives the whole of what was written to standard output, however long, and the end of everything for a person', async () => {
    // a status of many files is longer than any tail kept for reading
    const r = await run(
      'bash',
      [
        '-c',
        'for i in $(seq 1 3000); do echo "line $i of a long status"; done; echo oops >&2',
      ],
      { cwd, timeoutMs: 10_000 },
    );
    expect(r.code).toBe(0);
    expect(r.stdout.split('\n').filter(Boolean)).toHaveLength(3000);
    expect(r.stdout.startsWith('line 1 of a long status\n')).toBe(true);
    expect(r.out.length).toBeLessThanOrEqual(8000);
    expect(r.out).toContain('oops');
  });

  it('says how a command ended, and that one could not be started', async () => {
    expect(
      (await run('bash', ['-c', 'exit 3'], { cwd, timeoutMs: 5000 })).code,
    ).toBe(3);
    const none = await run('no-such-command-here', [], {
      cwd,
      timeoutMs: 5000,
    });
    expect(none.code).toBeNull();
  });

  it('keeps its time limit against a command that ignores being asked to stop', async () => {
    const t0 = Date.now();
    const r = await run('bash', ['-c', "trap '' TERM; sleep 60"], {
      cwd,
      timeoutMs: 200,
      graceMs: 300,
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('took too long');
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('is not held open by something the command left running with its pipes', async () => {
    const t0 = Date.now();
    // the shell exits at once; what it started keeps the output open for a minute
    const r = await run('bash', ['-c', "(trap '' TERM; sleep 60) & exit 0"], {
      cwd,
      timeoutMs: 300,
      graceMs: 300,
    });
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(r.out).toContain('took too long');
  });
});
