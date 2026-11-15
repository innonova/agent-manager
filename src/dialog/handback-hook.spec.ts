import { execFile } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const HOOK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'handback-hook.mjs',
);

/** Runs the hook as Claude would after a compaction: the event on stdin, what the agent is told on stdout. */
function run(event: unknown, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [HOOK],
      // never this session's own manager: a test run inside an agent has its URL and token
      {
        env: {
          ...process.env,
          AGENT_MANAGER_URL: '',
          AGENT_MANAGER_TOKEN: '',
          ...env,
        },
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
    child.stdin!.end(JSON.stringify(event));
  });
}

describe('hand-back hook', () => {
  it("prints the manager's notice after a compaction, and nothing when the manager is away, slow, refuses, or inside a subagent", async () => {
    const asked: { url?: string; method?: string; auth?: string }[] = [];
    let answer: () => {
      status: number;
      body: string;
      delay?: number;
    } = () => ({
      status: 200,
      body: JSON.stringify({ text: 'Read these files:\n/d/dialog-1.md' }),
    });
    const server = http.createServer((req, res) => {
      asked.push({
        url: req.url,
        method: req.method,
        auth: req.headers.authorization,
      });
      const a = answer();
      setTimeout(() => {
        res.writeHead(a.status, { 'content-type': 'application/json' });
        res.end(a.body);
      }, a.delay ?? 0);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const env = { AGENT_MANAGER_URL: url, AGENT_MANAGER_TOKEN: 'tok' };
    const event = {
      session_id: 's1',
      hook_event_name: 'SessionStart',
      source: 'compact',
    };
    try {
      expect(await run(event, env)).toBe('Read these files:\n/d/dialog-1.md\n');
      expect(asked).toEqual([
        { url: '/api/dialog/handback', method: 'POST', auth: 'Bearer tok' },
      ]);
      // a subagent's context is its own
      expect(await run({ ...event, agent_id: 'sub' }, env)).toBe('');
      expect(asked).toHaveLength(1);
      // no dialog yet, a refusal, a manager too slow: silence, never an error
      answer = () => ({ status: 200, body: JSON.stringify({ text: null }) });
      expect(await run(event, env)).toBe('');
      answer = () => ({ status: 403, body: '{}' });
      expect(await run(event, env)).toBe('');
      answer = () => ({ status: 200, body: '{"text":"late"}', delay: 600 });
      expect(
        await run(event, { ...env, AGENT_MANAGER_HANDBACK_MS: '150' }),
      ).toBe('');
    } finally {
      server.close();
    }
    // no manager at all
    expect(
      await run(event, {
        AGENT_MANAGER_URL: 'http://127.0.0.1:1/',
        AGENT_MANAGER_TOKEN: 'tok',
      }),
    ).toBe('');
    expect(await run(event, {})).toBe('');
  });
});
