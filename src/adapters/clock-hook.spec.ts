import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
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
function run(
  event: unknown,
  every: number,
  stateDir: string,
  env: Record<string, string> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [HOOK, '--every', String(every)],
      {
        // never this session's own manager: a test run inside an agent has its URL and token
        env: {
          ...process.env,
          AGENT_MANAGER_URL: '',
          AGENT_MANAGER_TOKEN: '',
          AGENT_MANAGER_CLOCK_STATE_DIR: stateDir,
          ...env,
        },
      },
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

  it('says that chat messages are unread when the manager says so, and nothing when it is away, slow or inside a subagent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clock-'));
    const asked: { url?: string; auth?: string }[] = [];
    let answer: { text: string | null } = { text: '2 unread messages' };
    let delay = 0;
    const server = http.createServer((req, res) => {
      asked.push({ url: req.url, auth: req.headers.authorization });
      setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(answer));
      }, delay);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    const env = {
      AGENT_MANAGER_URL: `http://127.0.0.1:${port}/`,
      AGENT_MANAGER_TOKEN: 'tok',
      AGENT_MANAGER_CHAT_NOTICE_MS: '300',
    };
    try {
      // with the clock off, only the chat speaks
      const said = JSON.parse(await run({ session_id: 'c1' }, 0, dir, env));
      expect(said.hookSpecificOutput.additionalContext).toBe(
        '2 unread messages',
      );
      expect(asked).toEqual([{ url: '/api/chat/notice', auth: 'Bearer tok' }]);
      // with the clock due, both, the time first
      const both = JSON.parse(
        await run({ session_id: 'c2' }, 60_000, dir, env),
      );
      expect(both.hookSpecificOutput.additionalContext).toMatch(
        /^The time is .+\n2 unread messages$/,
      );
      // nothing unread: silence
      answer = { text: null };
      expect(await run({ session_id: 'c1' }, 0, dir, env)).toBe('');
      // a tool call inside a subagent is not told, and not asked about
      answer = { text: '1 unread message' };
      const before = asked.length;
      expect(
        await run({ session_id: 'c1', agent_id: 'sub-1' }, 0, dir, env),
      ).toBe('');
      expect(asked).toHaveLength(before);
      // a slow manager: silence within the bound, not a hung tool call
      delay = 2000;
      const t0 = Date.now();
      expect(await run({ session_id: 'c1' }, 0, dir, env)).toBe('');
      expect(Date.now() - t0).toBeLessThan(1500);
    } finally {
      server.closeAllConnections();
      server.close();
    }
    // a manager that is not there
    expect(
      await run({ session_id: 'c1' }, 0, dir, {
        ...env,
        AGENT_MANAGER_URL: 'http://127.0.0.1:9',
      }),
    ).toBe('');
  });
});
