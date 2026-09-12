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
    svc = new ProjectsService(dbs);
  });
  afterEach(() => dbs.onModuleDestroy());

  it('creates, lists, updates and removes', () => {
    const p = svc.create({ name: ' P ', path: dir });
    expect(p).toMatchObject({ name: 'P', path: dir, defaultProfile: null });
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
});
