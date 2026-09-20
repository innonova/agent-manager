import fs from 'node:fs';
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
let projectDir: string;
let projectId: string;

const logFile = () => path.join(m.dataDir, 'learnings.md');

beforeAll(async () => {
  daemon = await startDaemon();
  m = await startManager(daemon.url);
  api = new Api(m.url);
  await api.login();
  projectDir = fs.mkdtempSync(path.join(m.dataDir, 'project-'));
  projectId = (
    await api.post('/api/projects', {
      name: 'learn',
      path: projectDir,
      defaultProfile: 'fake',
    })
  ).body.project.id;
}, 30000);

afterAll(async () => {
  await m?.stop();
  await daemon?.stop();
});

describe('the learnings log', () => {
  it('appends an entry and reads it back, numbered and attributed', async () => {
    const before = await api.get('/api/learnings');
    expect(before.status).toBe(200);
    expect(before.body.entries).toEqual([]); // no file yet is an empty log

    const first = await api.post('/api/learnings', {
      text: 'A short turn costs more than it looks: the note is resent at every session start.',
      ref: 'feature learnings-log-and-method-per-install',
    });
    expect(first.status).toBe(201);
    expect(first.body.entry).toMatchObject({
      n: 1,
      by: 'admin',
      ref: 'feature learnings-log-and-method-per-install',
    });
    expect(first.body.entry.at).toBeGreaterThan(0);

    const second = await api.post('/api/learnings', { text: 'Without a ref.' });
    expect(second.body.entry).toMatchObject({ n: 2, ref: null });

    const all = (await api.get('/api/learnings')).body.entries;
    expect(all.map((e: any) => e.n)).toEqual([1, 2]);
    expect(all[0].text).toContain('session start');
    // since: what has arrived after the entry the reader has seen
    expect(
      (await api.get('/api/learnings?since=1')).body.entries.map(
        (e: any) => e.n,
      ),
    ).toEqual([2]);
    expect((await api.get('/api/learnings?since=2')).body.entries).toEqual([]);

    // the file is the artifact: readable without the manager
    const text = fs.readFileSync(logFile(), 'utf8');
    expect(text).toContain('· admin · feature learnings');
    expect(text).toContain('Without a ref.');
  });

  it('refuses an empty entry and an oversized one', async () => {
    expect((await api.post('/api/learnings', { text: '   ' })).status).toBe(
      400,
    );
    expect((await api.post('/api/learnings', {})).status).toBe(400);
    expect(
      (await api.post('/api/learnings', { text: 'x'.repeat(17_000) })).status,
    ).toBe(400);
    expect(
      (await api.post('/api/learnings', { text: 'ok', ref: 'x'.repeat(300) }))
        .status,
    ).toBe(400);
  });

  it('only ever appends, and numbers a burst of entries without a gap or a repeat', async () => {
    const was = fs.readFileSync(logFile(), 'utf8');
    const posted = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        api.post('/api/learnings', { text: `burst entry ${i}` }),
      ),
    );
    expect(posted.every((r) => r.status === 201)).toBe(true);
    const ns = posted.map((r) => r.body.entry.n).sort((a, b) => a - b);
    expect(ns).toEqual(Array.from({ length: 20 }, (_, i) => i + 3)); // 1 and 2 exist
    const now = fs.readFileSync(logFile(), 'utf8');
    expect(now.startsWith(was)).toBe(true); // what was written stayed where it was
    const entries = (await api.get('/api/learnings')).body.entries;
    expect(entries).toHaveLength(22);
    expect(entries.map((e: any) => e.n)).toEqual(
      Array.from({ length: 22 }, (_, i) => i + 1),
    );
    // every burst entry is there exactly once
    for (let i = 0; i < 20; i++)
      expect(
        entries.filter((e: any) => e.text === `burst entry ${i}`),
      ).toHaveLength(1);
  });

  it('keeps an entry whole when its body looks like a header', async () => {
    const text =
      'The header is written by the manager:\n## 2026-09-20 11:30 · someone · run x\nand the parser has to survive that.';
    const before = (await api.get('/api/learnings')).body.entries.length;
    const posted = await api.post('/api/learnings', { text });
    expect(posted.status).toBe(201);
    const entries = (await api.get('/api/learnings')).body.entries;
    expect(entries).toHaveLength(before + 1);
    expect(entries[entries.length - 1].text).toContain('someone');
  });

  it('is an agent’s to write and to read, and the method is its to read only', async () => {
    const agent = (
      await api.post(`/api/projects/${projectId}/agents`, { name: 'learner' })
    ).body.agent as { id: string };
    await api.post(`/api/agents/${agent.id}/turn`, { text: 'token please' });
    let token = '';
    for (let i = 0; i < 50 && !token; i++) {
      const { items } = (await api.get(`/api/agents/${agent.id}/items`)).body;
      const said = items
        .filter((it: any) => it.item.kind === 'text')
        .map((it: any) => it.item.text)
        .join('\n');
      token = /token ([0-9a-f]{64})/.exec(said)?.[1] ?? '';
      if (!token) await sleep(200);
    }
    expect(token).not.toBe('');
    const own = new Api(m.url);
    own.bearer = token;

    const mine = await own.post('/api/learnings', {
      text: 'A helper records what it noticed while it is noticing it.',
      ref: 'agent learner',
    });
    expect(mine.status).toBe(201);
    expect(mine.body.entry.by).toBe('agent-learner');
    expect((await own.get('/api/learnings')).status).toBe(200);

    // the method and its framing it may read; rewriting them is a person's
    expect((await own.get('/api/method')).status).toBe(200);
    expect((await own.get('/api/method')).body.hosts[0].template).toContain(
      'Bringing an agent in',
    );
    expect(
      (await own.put('/api/method', { template: 'mine now' })).status,
    ).toBe(403);
    expect((await own.get('/api/framing')).status).toBe(200);
    expect((await own.get('/api/framing')).body.hosts[0].template).toContain(
      'Writing a feature',
    );
    expect(
      (await own.put('/api/framing', { template: 'mine now' })).status,
    ).toBe(403);
    // and the other operator files stay a person's, as before
    expect((await own.get('/api/harness')).status).toBe(403);
    expect((await own.get('/api/models')).status).toBe(403);
  }, 30000);
});
