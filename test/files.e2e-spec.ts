import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Api,
  TestDaemon,
  TestManager,
  startDaemon,
  startManager,
} from './helpers.js';

let daemon: TestDaemon;
let m: TestManager;
let api: Api;
let root: string;
let projectId: string;

beforeAll(async () => {
  daemon = await startDaemon();
  m = await startManager(daemon.url);
  api = new Api(m.url);
  await api.login();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-files-'));
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# hello\n');
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'deep', 'note.txt'), 'deep\n');
  fs.writeFileSync(path.join(root, '.hidden'), 'h');
  fs.writeFileSync(
    path.join(root, 'blob.bin'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
  );
  fs.writeFileSync(
    path.join(root, 'big.txt'),
    Buffer.alloc(2 * 1024 * 1024 + 1, 0x61),
  );
  fs.symlinkSync(path.join(root, 'src'), path.join(root, 'srclink'));
  fs.symlinkSync('/etc/hostname', path.join(root, 'outside'));
  const r = await api.post('/api/projects', { name: 'files', path: root });
  projectId = r.body.project.id;
}, 30000);

afterAll(async () => {
  await m?.stop();
  await daemon?.stop();
});

describe('files', () => {
  it('lists the root with directories first and every entry typed', async () => {
    const r = await api.get(`/api/projects/${projectId}/files`);
    expect(r.status).toBe(200);
    expect(r.body.path).toBe('');
    const names = r.body.entries.map((e: any) => `${e.type}:${e.name}`);
    expect(names.slice(0, 2)).toEqual(['dir:src', 'dir:srclink']); // a symlink to a directory lists as a directory
    expect(names).toContain('file:.hidden');
    expect(names).toContain('symlink:outside');
    const readme = r.body.entries.find((e: any) => e.name === 'README.md');
    expect(readme).toMatchObject({ path: 'README.md', type: 'file', size: 8 });
    expect(typeof readme.mtime).toBe('number');
  });

  it('lists nested directories by relative path and rejects leaving the project', async () => {
    const r = await api.get(`/api/projects/${projectId}/files?path=src/deep`);
    expect(r.body).toMatchObject({
      path: 'src/deep',
      entries: [{ name: 'note.txt', path: 'src/deep/note.txt', type: 'file' }],
    });
    expect(
      (await api.get(`/api/projects/${projectId}/files?path=/src/`)).body.path,
    ).toBe('src');
    expect(
      (await api.get(`/api/projects/${projectId}/files?path=..`)).status,
    ).toBe(400);
    expect(
      (await api.get(`/api/projects/${projectId}/files?path=src/../..`)).status,
    ).toBe(400);
    expect(
      (await api.get(`/api/projects/${projectId}/files?path=nope`)).status,
    ).toBe(404);
    expect(
      (await api.get(`/api/projects/${projectId}/files?path=README.md`)).status,
    ).toBe(400);
    expect((await api.get(`/api/projects/nope/files`)).status).toBe(404);
  });

  it('reads text files, flags binary and oversized ones', async () => {
    const r = await api.get(
      `/api/projects/${projectId}/file?path=src/index.ts`,
    );
    expect(r.body).toMatchObject({
      path: 'src/index.ts',
      content: 'export const x = 1;\n',
      binary: false,
      truncated: false,
      size: 20,
    });
    expect(
      (await api.get(`/api/projects/${projectId}/file?path=blob.bin`)).body,
    ).toMatchObject({ binary: true, content: '' });
    expect(
      (await api.get(`/api/projects/${projectId}/file?path=big.txt`)).body,
    ).toMatchObject({
      truncated: true,
      content: '',
      size: 2 * 1024 * 1024 + 1,
    });
    expect(
      (await api.get(`/api/projects/${projectId}/file?path=src`)).status,
    ).toBe(400);
    expect(
      (await api.get(`/api/projects/${projectId}/file?path=missing.txt`))
        .status,
    ).toBe(404);
    expect(
      (await api.get(`/api/projects/${projectId}/file?path=../etc/passwd`))
        .status,
    ).toBe(400);
    // symlinks are followed; containment is deliberately not attempted
    expect(
      (await api.get(`/api/projects/${projectId}/file?path=outside`)).status,
    ).toBe(200);
  });

  it('requires a login', async () => {
    expect(
      (await new Api(m.url).get(`/api/projects/${projectId}/files`)).status,
    ).toBe(401);
  });
});
