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

const file = (slug: string) => path.join(root, 'features', `${slug}.md`);
const read = (slug: string) => fs.readFileSync(file(slug), 'utf8');
const status = (slug: string) => /^status: (.+)$/m.exec(read(slug))?.[1];
const write = (slug: string, front: Record<string, unknown>, body: string) =>
  fs.writeFileSync(
    file(slug),
    `---\n${Object.entries(front)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`)
      .join('\n')}\n---\n\n${body}\n`,
  );
const featureEvent = (slug: string, st: string, from = 0) =>
  events.waitFor(
    (f) =>
      f.type === 'feature.changed' &&
      f.projectId === projectId &&
      f.feature.slug === slug &&
      f.feature.status === st,
    12000,
    from,
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
    { title: 'Login page', status: 'review', priority: 2, dependsOn: ['db'] },
    'Add a login page.\n\n## Report (2026-09-12)\n\nDone, with a form.',
  );
  write(
    'reports',
    { title: 'Reports', status: 'planned', priority: 3 },
    'Reports.',
  );
  write(
    'later',
    { title: 'Later', status: 'planned', priority: 1 },
    'Sooner, actually.',
  );
  write(
    'stuck',
    { title: 'Stuck', status: 'blocked', priority: 4 },
    'Needs a decision.',
  );
  write(
    'now',
    { title: 'Now', status: 'in-progress', priority: 9 },
    'Being worked on.',
  );
  write(
    'legacy',
    { title: 'Legacy', status: 'queued', priority: 50 },
    'From the queue days.',
  );
  fs.writeFileSync(path.join(root, 'features', 'notes.txt'), 'ignored');
  fs.mkdirSync(path.join(root, 'second', 'features'), { recursive: true });
  const r = await api.post('/api/projects', {
    name: 'features',
    repos: [
      { name: 'main', path: root },
      { name: 'second', path: path.join(root, 'second') },
    ],
  });
  projectId = r.body.project.id;
}, 30000);

afterAll(async () => {
  await events?.close();
  await m?.stop();
  await daemon?.stop();
});

describe('features', () => {
  it('lists features in working order, priority within a status; unknown or legacy statuses read as planned', async () => {
    const r = await api.get(`/api/projects/${projectId}/features`);
    expect(r.status).toBe(200);
    expect(
      r.body.features.map((f: any) => `${f.slug}:${f.status}:${f.priority}`),
    ).toEqual([
      'now:in-progress:9',
      'login:review:2',
      'stuck:blocked:4',
      'later:planned:1',
      'reports:planned:3',
      'legacy:planned:50',
      'db:done:1',
    ]);
    const login = r.body.features.find((f: any) => f.slug === 'login');
    expect(login).toMatchObject({
      repo: 'main',
      path: 'main/features/login.md',
      title: 'Login page',
      dependsOn: ['db'],
    });
    expect(login.body).toContain('## Report (2026-09-12)');
    expect(login.agentId).toBeUndefined();
  });

  it('creates a feature as planned in the primary repo, or a chosen one; rejects duplicates and bad input', async () => {
    const r = await api.post(`/api/projects/${projectId}/features`, {
      slug: 'search',
      title: 'Search',
      body: 'Full text.',
      priority: 7,
    });
    expect(r.status).toBe(201);
    expect(r.body.feature).toMatchObject({
      slug: 'search',
      status: 'planned',
      repo: 'main',
    });
    expect(read('search')).toBe(
      '---\ntitle: Search\nstatus: planned\npriority: 7\n---\n\nFull text.\n',
    );
    const other = await api.post(`/api/projects/${projectId}/features`, {
      slug: 'theme',
      title: 'Theme',
      repo: 'second',
    });
    expect(other.body.feature).toMatchObject({
      repo: 'second',
      path: 'second/features/theme.md',
    });
    expect(
      fs.existsSync(path.join(root, 'second', 'features', 'theme.md')),
    ).toBe(true);
    expect(
      (
        await api.post(`/api/projects/${projectId}/features`, {
          slug: 'search',
          title: 'x',
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
    expect(
      (
        await api.post(`/api/projects/${projectId}/features`, {
          slug: 'ok',
          title: 'x',
          repo: 'nope',
        })
      ).status,
    ).toBe(400);
  });

  it("sets the human's statuses, refuses in-progress and garbage, and announces the change", async () => {
    const mark = events.mark();
    const r = await api.patch(`/api/projects/${projectId}/features/reports`, {
      status: 'blocked',
    });
    expect(r.status).toBe(200);
    expect(status('reports')).toBe('blocked');
    await featureEvent('reports', 'blocked', mark);
    for (const st of ['planned', 'review', 'done', 'planned']) {
      expect(
        (
          await api.patch(`/api/projects/${projectId}/features/reports`, {
            status: st,
          })
        ).status,
      ).toBe(200);
      expect(status('reports')).toBe(st);
    }
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
        await api.patch(`/api/projects/${projectId}/features/nope`, {
          status: 'done',
        })
      ).status,
    ).toBe(404);
  });

  it('a response is appended as a dated section and sends the feature back to planned unless told otherwise', async () => {
    const r = await api.post(
      `/api/projects/${projectId}/features/login/respond`,
      {
        text: 'Also add a "forgot password" link.',
      },
    );
    expect(r.status).toBe(201);
    expect(r.body.feature.status).toBe('planned');
    const text = read('login');
    expect(text).toMatch(
      /Done, with a form\.\n\n## Response \(\d{4}-\d{2}-\d{2}\)\n\nAlso add a "forgot password" link\.\n$/,
    );
    expect(status('login')).toBe('planned');
    const closing = await api.post(
      `/api/projects/${projectId}/features/login/respond`,
      {
        text: 'Fine as it is.',
        status: 'done',
      },
    );
    expect(closing.body.feature.status).toBe('done');
    expect(read('login').split('## Response').length).toBe(3);
    expect(
      (
        await api.post(`/api/projects/${projectId}/features/login/respond`, {
          text: '  ',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api.post(`/api/projects/${projectId}/features/login/respond`, {
          text: 'x',
          status: 'in-progress',
        })
      ).status,
    ).toBe(400);
  });

  it("the agent's own edits are noticed: in-progress, then a report and review, then a new file", async () => {
    // What an agent does when asked to work on "later": no API involved.
    let mark = events.mark();
    write(
      'later',
      { title: 'Later', status: 'in-progress', priority: 1 },
      'Sooner, actually.',
    );
    const started = await featureEvent('later', 'in-progress', mark);
    expect(started.feature.body).toBe('Sooner, actually.\n');

    mark = events.mark();
    write(
      'later',
      { title: 'Later', status: 'review', priority: 1 },
      'Sooner, actually.\n\n## Report (2026-09-12)\n\nMoved it up. Left open: nothing.',
    );
    const reported = await featureEvent('later', 'review', mark);
    expect(reported.feature.body).toContain('## Report (2026-09-12)');

    mark = events.mark();
    write('fresh', { title: 'Fresh', status: 'planned' }, 'Written by hand.');
    const appeared = await featureEvent('fresh', 'planned', mark);
    expect(appeared.feature.title).toBe('Fresh');
    const list = await api.get(`/api/projects/${projectId}/features`);
    expect(list.body.features.map((f: any) => f.slug)).toContain('fresh');
  }, 30000); // three poll intervals

  it('a slug present in two repositories reads from the first', async () => {
    fs.writeFileSync(
      path.join(root, 'second', 'features', 'db.md'),
      '---\ntitle: Shadowed\nstatus: planned\n---\n\nshadow\n',
    );
    const r = await api.get(`/api/projects/${projectId}/features/db`);
    expect(r.body.feature).toMatchObject({ title: 'Database', repo: 'main' });
  });
});
