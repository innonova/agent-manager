import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DbService } from '../db/db.service.js';
import { loadConfig } from '../config/config.js';
import { ProjectsService } from './projects.service.js';

describe('ProjectsService', () => {
  let svc: ProjectsService;
  let dir: string;
  let dbs: DbService;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-'));
    dbs = new DbService({ ...loadConfig({}), dataDir: dir });
    dbs.onModuleInit();
    svc = new ProjectsService(dbs, { ...loadConfig({}), workspacesDir: dir });
  });
  afterEach(() => dbs.onModuleDestroy());

  it('creates, lists, updates and removes', () => {
    const p = svc.create({ name: ' P ', path: dir });
    expect(p).toMatchObject({ name: 'P', path: dir, defaultProfile: null });
    // the workspace file (here in the test's own dir, never beside a real repository) lists the repository
    expect(p.workspace).toBe(path.join(dir, 'P.code-workspace'));
    expect(JSON.parse(fs.readFileSync(p.workspace, 'utf8')).folders).toEqual([
      { name: path.basename(dir), path: dir },
    ]);
    expect(svc.list().map((x) => x.id)).toEqual([p.id]);
    expect(svc.update(p.id, { defaultProfile: 'fake' }).defaultProfile).toBe(
      'fake',
    );
    svc.remove(p.id);
    expect(svc.list()).toEqual([]);
    expect(() => svc.get(p.id)).toThrow(/no project/);
  });

  it('validates input', () => {
    expect(() => svc.create({ path: dir })).toThrow('"name"');
    expect(() => svc.create({ name: 'x', path: 'relative' })).toThrow(
      'absolute',
    );
    expect(() =>
      svc.create({ name: 'x', path: path.join(dir, 'missing') }),
    ).toThrow('not a directory');
    expect(() =>
      svc.create({ name: 'x', path: dir, defaultProfile: 1 }),
    ).toThrow('"defaultProfile"');
  });

  it('finds a stream that was on its way when the manager stopped where it set out from', () => {
    const home = (n: string) => path.join(dir, n);
    const a = svc.createStream({
      name: 'going',
      home: home('going'),
      defaultProfile: null,
      delegation: 'free',
      group: null,
    });
    const b = svc.createStream({
      name: 'coming',
      home: home('coming'),
      defaultProfile: null,
      delegation: 'free',
      group: null,
    });
    const c = svc.createStream({
      name: 'away',
      home: home('away'),
      defaultProfile: null,
      delegation: 'free',
      group: null,
    });
    expect(svc.away(a.id)).toBeNull();
    svc.setArchive(a.id, 'archiving');
    expect(svc.away(a.id)).toBe('the stream "going" is being put away');
    svc.setArchive(b.id, 'archived');
    const since = svc.get(b.id).archive!.at;
    expect(svc.setArchive(b.id, 'reviving').archive).toEqual({
      state: 'reviving',
      at: since, // away since it was put away
    });
    svc.setArchive(c.id, 'archived');
    svc.onModuleInit(); // the manager starts again
    expect(svc.get(a.id).archive).toBeNull(); // nothing is removed before a stream is away: it is there
    expect(svc.get(b.id).archive).toEqual({ state: 'archived', at: since }); // to be brought back again
    expect(svc.get(c.id).archive?.state).toBe('archived');
    expect(svc.away(c.id)).toContain('is put away; bring it back first');
  });
});
