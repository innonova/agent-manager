import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Api,
  Events,
  TestDaemon,
  TestManager,
  startDaemon,
  startManager,
} from './helpers.js';

let daemon: TestDaemon;
let m: TestManager;
let api: Api;
let events: Events;
let root: string;
let projectId: string;
let agentId: string;

const file = (slug: string) => path.join(root, 'features', `${slug}.md`);
const status = (slug: string) =>
  /^status: (.+)$/m.exec(fs.readFileSync(file(slug), 'utf8'))?.[1];
const write = (slug: string, front: Record<string, unknown>, body: string) =>
  fs.writeFileSync(
    file(slug),
    `---\n${Object.entries(front)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`)
      .join('\n')}\n---\n\n${body}\n`,
  );

beforeAll(async () => {
  daemon = await startDaemon();
  m = await startManager(daemon.url);
  api = new Api(m.url);
  await api.login();
  events = await Events.connect(m.url, api.cookie);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-features-'));
  fs.mkdirSync(path.join(root, 'features'));
  write(
    'db',
    { title: 'Database', status: 'done', priority: 1 },
    'Set up the database.',
  );
  write(
    'login',
    { title: 'Login page', status: 'planned', priority: 2, dependsOn: ['db'] },
    'Add a login page.\n\nWith a form.',
  );
  write(
    'reports',
    { title: 'Reports', status: 'planned', priority: 3, dependsOn: ['login'] },
    'Reports need login first.',
  );
  write(
    'oops',
    { title: 'Will error', status: 'planned', priority: 5 },
    'please error out',
  );
  fs.writeFileSync(path.join(root, 'features', 'notes.txt'), 'ignored');
  fs.mkdirSync(path.join(root, 'ui', 'features'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'ui', 'features', 'theme.md'),
    '---\ntitle: Theme\nstatus: planned\npriority: 8\n---\n\nDark mode.\n',
  );
  projectId = (
    await api.post('/api/projects', {
      name: 'feat',
      repos: [
        { name: 'main', path: root },
        { name: 'ui', path: path.join(root, 'ui') },
      ],
      defaultProfile: 'fake',
    })
  ).body.project.id;
  agentId = (
    await api.post(`/api/projects/${projectId}/agents`, { name: 'worker' })
  ).body.agent.id;
  await events.waitFor(
    (f) =>
      f.type === 'agent.state' &&
      f.agentId === agentId &&
      f.status.state === 'idle',
  );
}, 30000);

afterAll(async () => {
  await events?.close();
  await m?.stop();
  await daemon?.stop();
});

const featureEvent = (slug: string, st: string, from = 0) =>
  events.waitFor(
    (f) =>
      f.type === 'feature.changed' &&
      f.projectId === projectId &&
      f.feature.slug === slug &&
      f.feature.status === st,
    15000,
    from,
  );

describe('features', () => {
  it('lists the feature files, sorted, with derived titles and ignoring other files', async () => {
    const r = await api.get(`/api/projects/${projectId}/features`);
    expect(r.status).toBe(200);
    expect(
      r.body.features.map((f: any) => `${f.slug}:${f.status}:${f.priority}`),
    ).toEqual([
      'login:planned:2',
      'reports:planned:3',
      'oops:planned:5',
      'theme:planned:8',
      'db:done:1',
    ]);
    const login = r.body.features.find((f: any) => f.slug === 'login');
    expect(login).toMatchObject({
      title: 'Login page',
      dependsOn: ['db'],
      repo: 'main',
      path: 'main/features/login.md',
      agentId: null,
      lastRun: null,
    });
    expect(login.body).toContain('With a form.');
    expect(
      (await api.get(`/api/projects/${projectId}/features/nope`)).status,
    ).toBe(404);
  });

  it('creates a feature file', async () => {
    const r = await api.post(`/api/projects/${projectId}/features`, {
      slug: 'search',
      title: 'Search',
      body: 'Find things.',
      priority: 4,
    });
    expect(r.status).toBe(201);
    expect(r.body.feature).toMatchObject({
      slug: 'search',
      status: 'planned',
      priority: 4,
    });
    expect(fs.readFileSync(file('search'), 'utf8')).toBe(
      '---\ntitle: Search\nstatus: planned\npriority: 4\n---\n\nFind things.\n',
    );
    expect(
      (
        await api.post(`/api/projects/${projectId}/features`, {
          slug: 'search',
          title: 'again',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await api.post(`/api/projects/${projectId}/features`, {
          slug: 'Bad Slug',
          title: 'x',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api.post(`/api/projects/${projectId}/features`, {
          slug: 'ok',
          title: '',
        })
      ).status,
    ).toBe(400);
  });

  it('refuses to queue behind an unfinished dependency', async () => {
    const r = await api.post(
      `/api/projects/${projectId}/features/reports/queue`,
      { agentId },
    );
    expect(r.status).toBe(409);
    expect(r.body.message).toContain('login');
    expect(status('reports')).toBe('planned');
  });

  it('queues a feature, sends the spec as a turn, and moves it to review when the agent finishes', async () => {
    const mark = events.mark();
    const r = await api.post(
      `/api/projects/${projectId}/features/login/queue`,
      { agentId },
    );
    expect(r.status).toBe(202);
    await featureEvent('login', 'in-progress', mark);
    expect(status('login')).toBe('in-progress');
    const turn = await events.waitFor(
      (f) =>
        f.type === 'agent.item' &&
        f.agentId === agentId &&
        f.item.item.kind === 'user',
      10000,
      mark,
    );
    expect(turn.item.item.text).toContain(
      `Implement the feature "Login page", described in ${path.join(root, 'features', 'login.md')} (repository "main")`,
    );
    expect(turn.item.item.text).toContain(
      'This project spans several repositories; your working directory is one of them',
    );
    expect(turn.item.item.text).toContain('With a form.');
    expect(turn.item.item.text).toContain('Do not change the status field');
    const done = await featureEvent('login', 'review', mark);
    expect(done.feature.lastRun).toMatchObject({ agentId, outcome: 'review' });
    expect(done.feature.lastRun.endedAt).toBeTruthy();
    expect(status('login')).toBe('review');
    expect(done.feature.agentId).toBeNull();
  });

  it('marks a feature blocked when the agent errors', async () => {
    const mark = events.mark();
    await api.post(`/api/projects/${projectId}/features/oops/queue`, {
      agentId,
    });
    const blocked = await featureEvent('oops', 'blocked', mark);
    expect(blocked.feature.lastRun.outcome).toMatch(/^blocked: .*usage limit/);
    expect(status('oops')).toBe('blocked');
  });

  it('queues behind a busy agent and starts when it is free; dequeue takes it back', async () => {
    write(
      'slow',
      { title: 'Slow one', status: 'planned', priority: 1 },
      'slow please',
    );
    write('after', { title: 'After', status: 'planned', priority: 2 }, 'quick');
    const mark = events.mark();
    await api.post(`/api/projects/${projectId}/features/slow/queue`, {
      agentId,
    });
    await featureEvent('slow', 'in-progress', mark);
    const queued = await api.post(
      `/api/projects/${projectId}/features/after/queue`,
      { agentId },
    );
    expect(queued.status).toBe(202);
    expect(queued.body.feature).toMatchObject({ status: 'queued', agentId });
    expect(status('after')).toBe('queued');
    // a second queue of the same feature is refused; dequeue puts it back to planned
    expect(
      (
        await api.post(`/api/projects/${projectId}/features/after/queue`, {
          agentId,
        })
      ).status,
    ).toBe(409);
    expect(
      (await api.post(`/api/projects/${projectId}/features/after/dequeue`)).body
        .feature.status,
    ).toBe('planned');
    expect(status('after')).toBe('planned');
    // queue it again and let the agent reach it
    await api.post(`/api/projects/${projectId}/features/after/queue`, {
      agentId,
    });
    await featureEvent('slow', 'review', mark);
    await featureEvent('after', 'in-progress', mark);
    await featureEvent('after', 'review', mark);
    const runs = (await api.get(`/api/projects/${projectId}/features/after`))
      .body.feature.lastRun;
    expect(runs.outcome).toBe('review');
  }, 40000);

  it('lets the human set done, reopen, and refuses manager-owned states', async () => {
    expect(
      (
        await api.patch(`/api/projects/${projectId}/features/login`, {
          status: 'done',
        })
      ).body.feature.status,
    ).toBe('done');
    expect(status('login')).toBe('done');
    // the dependency is now met
    const mark = events.mark();
    expect(
      (
        await api.post(`/api/projects/${projectId}/features/reports/queue`, {
          agentId,
        })
      ).status,
    ).toBe(202);
    await featureEvent('reports', 'review', mark);
    expect(
      (
        await api.patch(`/api/projects/${projectId}/features/reports`, {
          status: 'planned',
        })
      ).body.feature.status,
    ).toBe('planned');
    expect(
      (
        await api.patch(`/api/projects/${projectId}/features/reports`, {
          status: 'in-progress',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api.patch(`/api/projects/${projectId}/features/reports`, {
          status: 'queued',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api.post(`/api/projects/${projectId}/features/login/queue`, {
          agentId,
        })
      ).status,
    ).toBe(409); // done
  }, 30000);

  it('keeps unknown frontmatter and the body intact when it rewrites a file', async () => {
    write(
      'keep',
      {
        title: 'Keep',
        status: 'planned',
        priority: 9,
        owner: 'anders',
        tags: ['a', 'b'],
      },
      '# Keep\n\nBody stays.\n\n- one\n- two',
    );
    await api.patch(`/api/projects/${projectId}/features/keep`, {
      status: 'review',
    });
    const text = fs.readFileSync(file('keep'), 'utf8');
    expect(text).toContain('status: review');
    expect(text).toContain('owner: anders');
    expect(text).toMatch(/tags:\n\s+- a\n\s+- b/);
    expect(text).toContain('Body stays.\n\n- one\n- two\n');
  });

  it('creates a feature in a chosen repo and reads it back from there', async () => {
    const r = await api.post(`/api/projects/${projectId}/features`, {
      slug: 'palette',
      title: 'Palette',
      repo: 'ui',
    });
    expect(r.status).toBe(201);
    expect(r.body.feature).toMatchObject({
      repo: 'ui',
      path: 'ui/features/palette.md',
    });
    expect(fs.existsSync(path.join(root, 'ui', 'features', 'palette.md'))).toBe(
      true,
    );
    expect(
      (await api.get(`/api/projects/${projectId}/features/theme`)).body.feature,
    ).toMatchObject({ repo: 'ui', title: 'Theme' });
    expect(
      (
        await api.post(`/api/projects/${projectId}/features`, {
          slug: 'x',
          title: 'x',
          repo: 'nope',
        })
      ).status,
    ).toBe(400);
  });

  it('rejects an agent from another project', async () => {
    const other = (
      await api.post('/api/projects', {
        name: 'other',
        path: root,
        defaultProfile: 'fake',
      })
    ).body.project.id;
    const foreign = (
      await api.post(`/api/projects/${other}/agents`, { name: 'w2' })
    ).body.agent.id;
    expect(
      (
        await api.post(`/api/projects/${projectId}/features/search/queue`, {
          agentId: foreign,
        })
      ).status,
    ).toBe(400);
    expect(
      (await api.post(`/api/projects/${projectId}/features/search/queue`, {}))
        .status,
    ).toBe(400);
  });
});
