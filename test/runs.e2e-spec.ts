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

let daemon: TestDaemon;
let m: TestManager;
let api: Api;
let repo: string;
let projectId: string;
/** A single-path project names its repository after the directory. */
let repoName: string;

const git = (...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t.t', ...args],
    { cwd: repo },
  )
    .toString()
    .trim();

/** How often the manager re-reads feature files (FeaturesService's POLL_MS). */
const POLL_MS = 3000;

/** A feature file as an agent writes it: the manager only ever reads these. */
const writeFeature = (slug: string, status: string, body: string) => {
  fs.mkdirSync(path.join(repo, 'features'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'features', `${slug}.md`),
    `---\ntitle: ${slug}\nstatus: ${status}\npriority: 1\n---\n\n${body}\n`,
  );
};

/** The poller notices file edits every few seconds; this waits for what follows one. */
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

const runsOf = async (slug: string) =>
  (await api.get(`/api/runs?project=${projectId}&feature=${slug}`)).body
    .runs as any[];

beforeAll(async () => {
  daemon = await startDaemon();
  m = await startManager(daemon.url);
  api = new Api(m.url);
  await api.login();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'am-runs-'));
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'README.md'), 'one\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  const r = await api.post('/api/projects', {
    name: 'runs',
    path: repo,
    defaultProfile: 'fake',
  });
  projectId = r.body.project.id;
  repoName = r.body.project.repos[0].name;
}, 30000);

afterAll(async () => {
  await m?.stop();
  await daemon?.stop();
});

describe('run log', () => {
  it('records nothing when no agent was working, and refuses an agent its token', async () => {
    writeFeature('orphan', 'planned', 'Nobody is on this.');
    await sleep(POLL_MS + 500);
    writeFeature('orphan', 'in-progress', 'Nobody is on this.');
    await sleep(POLL_MS + 1500); // the transition is seen; nobody owns it
    expect(await runsOf('orphan')).toHaveLength(0);

    // an agent's token reaches its project, not the run log (a human's view)
    const created = await api.post(`/api/projects/${projectId}/agents`, {
      name: 'reader',
    });
    const agent = created.body.agent as { id: string };
    await api.post(`/api/agents/${agent.id}/turn`, { text: 'token please' });
    const said = await until('the agent to say its token', async () => {
      const { items } = (await api.get(`/api/agents/${agent.id}/items`)).body;
      const text = items
        .filter((i: any) => i.item.kind === 'text')
        .map((i: any) => i.item.text)
        .join('\n');
      return /token ([0-9a-f]{64})/.exec(text)?.[1] ?? null;
    });
    const own = new Api(m.url);
    own.bearer = said;
    expect((await own.get('/api/runs')).status).toBe(403);
  }, 60000);
  it('records a run from in-progress to review, with its commits, spend, report and transcript', async () => {
    const created = await api.post(`/api/projects/${projectId}/agents`, {
      name: 'worker',
      model: 'fake-2',
    });
    const agent = created.body.agent as { id: string };
    // The feature exists as planned first: a run is a transition, and a
    // feature already in progress when the manager first sees a project
    // started before it was watching.
    writeFeature('widget', 'planned', 'Build a widget.');
    await until('the poller to see the feature', async () => {
      const r = await api.get(`/api/projects/${projectId}/features`);
      return r.body.features?.some((f: any) => f.slug === 'widget') ?? false;
    });
    await sleep(POLL_MS + 500); // and to have its status on record
    // the agent is working while the feature goes in progress, which is
    // what attributes the run to it
    await api.post(`/api/agents/${agent.id}/turn`, { text: 'linger please' });
    await until(
      'the agent to be working',
      async () =>
        (await api.get(`/api/agents/${agent.id}`)).body.status.state ===
        'working',
    );
    writeFeature('widget', 'in-progress', 'Build a widget.');
    const open = await until('the run to open', async () => {
      const [run] = await runsOf('widget');
      return run ?? null;
    });
    expect(open).toMatchObject({
      slug: 'widget',
      repo: repoName,
      agentId: agent.id,
      agentName: 'worker',
      profile: 'fake',
      model: 'fake-2',
      endedAt: null,
      outcome: null,
    });
    expect(open.baseCommit).toMatch(/^[0-9a-f]{7,}$/); // HEAD when it started

    // what the agent does from here belongs to the run: a message steered
    // into its turn, and the end of the turn itself
    await api.post(`/api/agents/${agent.id}/turn`, {
      text: 'a word while you work',
      steer: true,
    });
    await api.post(`/api/agents/${agent.id}/interrupt`);
    await until(
      'the turn to end',
      async () =>
        (await api.get(`/api/agents/${agent.id}`)).body.status.state === 'idle',
    );

    // the agent commits its work and reports; the human's status change
    // ends the run
    fs.writeFileSync(path.join(repo, 'widget.txt'), 'done\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'the widget');
    writeFeature(
      'widget',
      'in-progress',
      'Build a widget.\n\n## Report (2026-09-20)\n\nBuilt it. Tests pass.',
    );
    await sleep(3500); // let the poller read the report before the status change
    const closed = await api.patch(
      `/api/projects/${projectId}/features/widget`,
      { status: 'review' },
    );
    expect(closed.status).toBe(200);
    const done = await until('the run to close', async () => {
      const [run] = await runsOf('widget');
      return run?.endedAt ? run : null;
    });
    expect(done).toMatchObject({
      outcome: 'feature',
      featureStatus: 'review',
      id: open.id,
    });
    expect(done.endCommit).toMatch(/^[0-9a-f]{7,}$/);
    expect(done.endCommit).not.toBe(done.baseCommit); // it committed
    expect(done.report).toContain('Built it. Tests pass.');
    expect(done.itemTo).toBeGreaterThan(done.itemFrom);
    // the fake vendor reported no spend in this window: no data, not zero
    expect(done.turns).toBeNull();
    expect(done.costUsd).toBeNull();

    const one = await api.get(`/api/runs/${done.id}`);
    expect(one.status).toBe(200);
    expect(one.body.transcript.length).toBeGreaterThan(0);
    expect(
      one.body.transcript.every(
        (i: any) => i.index >= done.itemFrom && i.index < done.itemTo,
      ),
    ).toBe(true);

    // and it outlives the agent, transcript and all
    expect((await api.delete(`/api/agents/${agent.id}`)).status).toBe(200);
    const after = await api.get(`/api/runs/${done.id}`);
    expect(after.body.run).toMatchObject({ agentName: 'worker' });
    expect(after.body.transcript.length).toBe(one.body.transcript.length);
  }, 60000);
});
