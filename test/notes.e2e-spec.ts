import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDaemon, startManager, Api, Events, sleep } from './helpers.js';
import type { TestDaemon, TestManager } from './helpers.js';

/**
 * A project's notes: small actionable items, one file each under
 * `notes/` in the primary repository. Added from the UI while an agent
 * works, ticked by the agent (through the API or by editing the file),
 * and every tab hears about it.
 */
let daemon: TestDaemon;
let m: TestManager;
let api: Api;
let events: Events;
let repo: string;
let project: { id: string };

beforeAll(async () => {
  daemon = await startDaemon();
  m = await startManager(daemon.url);
  api = new Api(m.url);
  await api.login();
  events = await Events.connect(m.url, api.cookie);
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'am-notes-'));
  project = (await api.post('/api/projects', { name: 'noted', path: repo }))
    .body.project;
}, 30000);

afterAll(async () => {
  await events?.close();
  await m?.stop();
  await daemon?.stop();
});

describe('notes', () => {
  it('adds, lists open first, ticks, edits and removes; each change is a file and an event', async () => {
    expect((await api.get(`/api/projects/${project.id}/notes`)).body).toEqual({
      dir: 'notes',
      items: [],
      open: 0,
    });
    let mark = events.mark();
    const added = await api.post(`/api/projects/${project.id}/notes`, {
      text: 'show the stats of the selected weapon\n\nIn the right panel, the same numbers the hangar shows.',
    });
    expect(added.status).toBe(201);
    const [it] = added.body.items;
    expect(it).toMatchObject({
      done: false,
      title: 'show the stats of the selected weapon',
      body: 'In the right panel, the same numbers the hangar shows.',
    });
    expect(it.id).toMatch(/^[a-z0-9]{5}$/);
    expect(it.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(fs.existsSync(path.join(repo, 'notes', `${it.id}.md`))).toBe(true);
    await events.waitFor(
      (f) =>
        f.type === 'notes.changed' &&
        f.projectId === project.id &&
        f.notes.open === 1,
      5000,
      mark,
    );
    // a second one, then the first ticked: done ones sort last
    const second = (
      await api.post(`/api/projects/${project.id}/notes`, { text: 'second' })
    ).body.items.find((x: { title: string }) => x.title === 'second');
    const ticked = await api.patch(
      `/api/projects/${project.id}/notes/${it.id}`,
      {
        done: true,
      },
    );
    expect(ticked.status).toBe(200);
    expect(ticked.body.items.map((x: { id: string }) => x.id)).toEqual([
      second.id,
      it.id,
    ]);
    expect(ticked.body.open).toBe(1);
    expect(
      fs.readFileSync(path.join(repo, 'notes', `${it.id}.md`), 'utf8'),
    ).toContain('done: true');
    // edited text keeps the id and the date
    const edited = (
      await api.patch(`/api/projects/${project.id}/notes/${second.id}`, {
        text: 'second, reworded\nwith a body',
      })
    ).body.items.find((x: { id: string }) => x.id === second.id);
    expect(edited).toMatchObject({
      title: 'second, reworded',
      body: 'with a body',
      date: second.date,
    });
    // bad input
    expect(
      (await api.post(`/api/projects/${project.id}/notes`, { text: '  ' }))
        .status,
    ).toBe(400);
    expect(
      (
        await api.patch(`/api/projects/${project.id}/notes/${it.id}`, {
          done: 'yes',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api.patch(`/api/projects/${project.id}/notes/zzzzz`, {
          done: true,
        })
      ).status,
    ).toBe(404);
    // removed
    expect(
      (await api.delete(`/api/projects/${project.id}/notes/${it.id}`)).status,
    ).toBe(200);
    expect(fs.existsSync(path.join(repo, 'notes', `${it.id}.md`))).toBe(false);
    expect(
      (await api.delete(`/api/projects/${project.id}/notes/${it.id}`)).status,
    ).toBe(404);
  });

  it('an agent ticking a note by editing its file is noticed by the poll', async () => {
    const added = (
      await api.post(`/api/projects/${project.id}/notes`, { text: 'by hand' })
    ).body.items.find((x: { title: string }) => x.title === 'by hand');
    await sleep(200);
    const mark = events.mark();
    const file = path.join(repo, 'notes', `${added.id}.md`);
    fs.writeFileSync(
      file,
      fs.readFileSync(file, 'utf8').replace('done: false', 'done: true'),
    );
    const frame = await events.waitFor(
      (f) =>
        f.type === 'notes.changed' &&
        f.projectId === project.id &&
        f.notes.items.some(
          (x: { id: string; done: boolean }) => x.id === added.id && x.done,
        ),
      8000,
      mark,
    );
    expect(
      frame.notes.items.find((x: { id: string }) => x.id === added.id).done,
    ).toBe(true);
    // a note written by hand without front matter is listed too, open and undated
    fs.writeFileSync(
      path.join(repo, 'notes', 'byhand.md'),
      'typed straight into a file\n',
    );
    await events.waitFor(
      (f) =>
        f.type === 'notes.changed' &&
        f.projectId === project.id &&
        f.notes.items.some((x: { id: string }) => x.id === 'byhand'),
      8000,
      mark,
    );
    const list = (await api.get(`/api/projects/${project.id}/notes`)).body
      .items;
    expect(list.find((x: { id: string }) => x.id === 'byhand')).toMatchObject({
      done: false,
      date: '',
      title: 'typed straight into a file',
    });
  }, 20000);
});
