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
 * The idle end of a run, on a manager whose clocks are seconds rather
 * than hours: a run whose agent goes quiet is abandoned, and the
 * manager's own poke of a stalled agent does not stand in the way. Its
 * own manager, since a four-second idle timeout would abandon the runs of
 * every other test in the file while they wait for the poller.
 */
let daemon: TestDaemon;
let m: TestManager;
let api: Api;
let repo: string;
let projectId: string;

const IDLE_MS = 4000;
const POLL_MS = 3000; // FeaturesService's own cadence

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

beforeAll(async () => {
  daemon = await startDaemon();
  m = await startManager(daemon.url, undefined, {
    runIdleMs: IDLE_MS,
    backgroundPokeMs: 1500,
  });
  api = new Api(m.url);
  await api.login();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'am-idle-'));
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'README.md'), 'one\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  projectId = (
    await api.post('/api/projects', {
      name: 'idle',
      path: repo,
      defaultProfile: 'fake',
    })
  ).body.project.id;
}, 30000);

afterAll(async () => {
  await m?.stop();
  await daemon?.stop();
});

/** Opens a run: a feature that was planned goes in progress while an agent works. */
async function openRun(slug: string, agentName: string): Promise<string> {
  const agent = (
    await api.post(`/api/projects/${projectId}/agents`, { name: agentName })
  ).body.agent as { id: string };
  writeFeature(slug, 'planned');
  await until('the poller to see the feature', async () => {
    const r = await api.get(`/api/projects/${projectId}/features`);
    return r.body.features?.some((f: any) => f.slug === slug) ?? false;
  });
  await sleep(POLL_MS + 500);
  await api.post(`/api/agents/${agent.id}/turn`, { text: 'linger please' });
  await until(
    'the agent to be working',
    async () =>
      (await api.get(`/api/agents/${agent.id}`)).body.status.state ===
      'working',
  );
  writeFeature(slug, 'in-progress');
  await until('the run to open', async () => (await runOf(slug)) ?? null);
  return agent.id;
}

describe('a run that goes quiet', () => {
  it('is abandoned once the agent has done nothing of its own for the timeout', async () => {
    const agentId = await openRun('quiet', 'quitter');
    await api.post(`/api/agents/${agentId}/interrupt`);
    await until(
      'the turn to end',
      async () =>
        (await api.get(`/api/agents/${agentId}`)).body.status.state === 'idle',
    );
    const abandoned = await until(
      'the run to be abandoned',
      async () => {
        const run = await runOf('quiet');
        return run?.endedAt ? run : null;
      },
      IDLE_MS * 4,
    );
    expect(abandoned).toMatchObject({
      outcome: 'abandoned',
      featureStatus: 'in-progress', // it never left, which is why the sweep had to end it
    });
    // the feature is still in progress and nothing reopens the run
    await sleep(POLL_MS);
    expect((await runsOfAll('quiet')).filter((r: any) => !r.endedAt)).toEqual(
      [],
    );
  }, 60000);

  it('is not abandoned while the agent is working, and the manager’s poke does not keep it alive', async () => {
    const agentId = await openRun('busy', 'worker');
    // working: the clock does not run at all
    await sleep(IDLE_MS + 1000);
    expect((await runOf('busy')).endedAt).toBeNull();

    // now idle, with a background job pending, which is what makes the
    // manager poke it; the poke is a turn of the manager's, not work of
    // the agent's, so the run grows old regardless of it
    await api.post(`/api/agents/${agentId}/interrupt`);
    await until(
      'the turn to end',
      async () =>
        (await api.get(`/api/agents/${agentId}`)).body.status.state === 'idle',
    );
    await api.post(`/api/agents/${agentId}/turn`, {
      text: 'start a background job',
    });
    await until(
      'the background job to be pending',
      async () =>
        (await api.get(`/api/agents/${agentId}`)).body.status.background === 1,
    );
    const abandoned = await until(
      'the run to be abandoned',
      async () => {
        const run = await runOf('busy');
        return run?.endedAt ? run : null;
      },
      IDLE_MS * 5,
    );
    expect(abandoned.outcome).toBe('abandoned');
    // and the poke did happen, attributed to the manager
    const { items } = (await api.get(`/api/agents/${agentId}/items`)).body;
    const poke = items.find(
      (i: any) => i.item.kind === 'user' && i.item.by === 'manager',
    );
    expect(poke).toBeTruthy();
  }, 60000);
});

const runsOfAll = async (slug: string) =>
  (await api.get(`/api/runs?project=${projectId}&feature=${slug}`)).body
    .runs as any[];
