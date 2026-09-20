import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Api,
  TestDaemon,
  TestManager,
  sleep,
  startDaemon,
  startManager,
} from './helpers.js';

/**
 * A run whose manager is reinstalled while it is open. The manager
 * restarts, the daemon keeps the sessions, and the two readings of the
 * vendor's counters that make up a run's spend must still be comparable —
 * or, if they cannot be, say nothing rather than zero (learnings #1).
 *
 * A real reinstall ends every session on the machine; a manager stopped
 * and started again on the same data directory is what it does to the
 * manager's memory, which is the part under test.
 */
let daemon: TestDaemon;
let m: TestManager;
let api: Api;
let repo: string;
let projectId: string;

const POLL_MS = 3000;

const git = (...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t.t', ...args],
    { cwd: repo },
  )
    .toString()
    .trim();

const writeFeature = (slug: string, status: string) => {
  fs.mkdirSync(path.join(repo, 'features'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'features', `${slug}.md`),
    `---\ntitle: ${slug}\nstatus: ${status}\npriority: 1\n---\n\nA feature.\n`,
  );
};

async function until<T>(
  what: string,
  fn: () => Promise<T | null | undefined>,
  timeoutMs = 20000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = await fn();
    if (got) return got;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

const runOf = async (slug: string) =>
  (await api.get(`/api/runs?project=${projectId}&feature=${slug}`)).body
    .runs[0] as any;

const statusOf = async (id: string) =>
  (await api.get(`/api/agents/${id}`)).body.status;

/**
 * A turn that ends, so the session settles and the transcript cache is
 * written. `want` is the state it ends in: "please exit" leaves the
 * process gone, and the next turn resumes the agent in a new session.
 */
async function turn(
  id: string,
  text: string,
  want: 'idle' | 'exited' = 'idle',
): Promise<void> {
  await api.post(`/api/agents/${id}/turn`, { text });
  await until(
    `the turn "${text}" to end`,
    async () => (await statusOf(id)).state === want,
  );
}

beforeAll(async () => {
  daemon = await startDaemon();
  m = await startManager(daemon.url);
  api = new Api(m.url);
  await api.login();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'am-restart-'));
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'README.md'), 'one\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  projectId = (
    await api.post('/api/projects', {
      name: 'restart',
      path: repo,
      defaultProfile: 'fake',
    })
  ).body.project.id;
}, 30000);

afterAll(async () => {
  await m?.stop();
  await daemon?.stop();
});

/** Restarts the manager on its own data directory, as a reinstall does. */
async function restartManager(clearCache = false): Promise<void> {
  const dataDir = m.dataDir;
  await m.stop();
  if (clearCache)
    fs.rmSync(path.join(dataDir, 'transcripts'), {
      recursive: true,
      force: true,
    });
  m = await startManager(daemon.url, dataDir);
  api = new Api(m.url);
  await api.login();
}

/**
 * An agent with spend on two sessions, so its usage has a `total` and not
 * only the current session's `spend`, and a run of its own opened while
 * it works.
 */
async function agentWithSpendAndRun(
  name: string,
  slug: string,
): Promise<{ agentId: string; total: any }> {
  const agentId = (
    await api.post(`/api/projects/${projectId}/agents`, { name })
  ).body.agent.id as string;
  await turn(agentId, 'usage 10 please');
  await turn(agentId, 'please exit', 'exited'); // the next turn resumes it in a new session
  await turn(agentId, 'usage 20 please');
  const status = await statusOf(agentId);
  // the precondition this whole file rests on: more than one session's
  // spend is loaded, so the reading is on the `total` basis
  expect(status.usage?.total).toBeTruthy();
  expect(status.usage.total.turns).toBeGreaterThan(status.usage.spend.turns);

  writeFeature(slug, 'planned');
  await until('the poller to see the feature', async () => {
    const r = await api.get(`/api/projects/${projectId}/features`);
    return r.body.features?.some((f: any) => f.slug === slug) ?? false;
  });
  await sleep(POLL_MS + 500);
  await api.post(`/api/agents/${agentId}/turn`, { text: 'linger please' });
  await until(
    'the agent to be working',
    async () => (await statusOf(agentId)).state === 'working',
  );
  writeFeature(slug, 'in-progress');
  const run = await until(
    'the run to open',
    async () => (await runOf(slug)) ?? null,
  );
  expect(run.agentId).toBe(agentId);
  return { agentId, total: status.usage.total };
}

/** Ends the lingering turn, so the agent is idle when the manager goes. */
async function settle(agentId: string): Promise<void> {
  await api.post(`/api/agents/${agentId}/interrupt`);
  await until(
    'the turn to end',
    async () => (await statusOf(agentId)).state === 'idle',
  );
}

/** One more priced turn inside the run, then the feature moves and the run closes. */
async function spendAndClose(agentId: string, slug: string): Promise<any> {
  await turn(agentId, 'usage 30 please');
  await api.patch(`/api/projects/${projectId}/features/${slug}`, {
    status: 'review',
  });
  return await until('the run to close', async () => {
    const run = await runOf(slug);
    return run?.endedAt ? run : null;
  });
}

describe('a run across a restart of the manager', () => {
  it('makes a close that was pending when the manager went down', async () => {
    await agentWithSpendAndRun('lingerer', 'sprocket');
    const startedAt = Date.now(); // the linger turn runs about 20 s by itself
    // the feature moves inside the turn: the close waits for its end
    writeFeature('sprocket', 'review');
    await until('the close to be pending', async () => {
      const run = await runOf('sprocket');
      return run?.closing ? run : null;
    });

    // the manager goes away, and the turn ends while it is down
    const dataDir = m.dataDir;
    await m.stop();
    await sleep(Math.max(0, 22_000 - (Date.now() - startedAt)));
    m = await startManager(daemon.url, dataDir);
    api = new Api(m.url);
    await api.login();

    // the sweep finds a pending close whose agent is no longer in a turn
    const done = await until(
      'the run to close after the restart',
      async () => {
        const run = await runOf('sprocket');
        return run?.endedAt ? run : null;
      },
      30000,
    );
    expect(done).toMatchObject({
      outcome: 'feature',
      featureStatus: 'review', // the status the poller saw before the restart
      closing: null,
    });
  }, 180000);

  it('keeps its spend comparable when the transcript cache is there', async () => {
    const { agentId, total } = await agentWithSpendAndRun('spender', 'widget');
    await settle(agentId);

    await restartManager();
    // the status carries what the cache knew, at once: not blank until the
    // next turn end, which is what moved the two readings apart
    const restored = await until(
      'the restored usage',
      async () => (await statusOf(agentId)).usage ?? null,
    );
    expect(restored.total.turns).toBe(total.turns);
    expect(restored.spend).toBeTruthy();
    // what the cache put back is spend only (see spendOnlyUsage and its
    // spec); by the time an HTTP call can see the status, the session's
    // replay has spoken again and the live report stands, which is the
    // order that matters: the cache is the floor, never the last word
    expect(restored.at).toBeGreaterThan(0);

    // more spend during the run, then the feature moves and the run ends
    const done = await spendAndClose(agentId, 'widget');
    expect(done.outcome).toBe('feature');
    // one `usage 30` turn happened inside the run: its spend is the
    // difference, not null and not the agent's whole life
    expect(done.turns).toBe(1);
    expect(done.inputTokens).toBe(30_000);
    expect(done.outputTokens).toBe(300);
    expect(done.costUsd).toBeCloseTo(0.3, 5);
  }, 120000);

  it('rebuilds the same figures from the daemon log when the cache is gone', async () => {
    const { agentId, total } = await agentWithSpendAndRun('rebuilt', 'gizmo');
    await settle(agentId);

    // the transcript cache is an optimisation, not the record: with it
    // deleted the manager replays the sessions' logs instead
    await restartManager(true);
    const restored = await until(
      'the rebuilt usage',
      async () => (await statusOf(agentId)).usage ?? null,
    );
    expect(restored.total.turns).toBe(total.turns);

    const done = await spendAndClose(agentId, 'gizmo');
    expect(done.turns).toBe(1);
    expect(done.inputTokens).toBe(30_000);
    expect(done.costUsd).toBeCloseTo(0.3, 5);
  }, 120000);
});
