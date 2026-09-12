import { execFileSync } from 'node:child_process';
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
  fs.mkdirSync(path.join(root, 'second', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'second', 'lib', 'x.txt'), 'second repo\n');
  const r = await api.post('/api/projects', {
    name: 'files',
    repos: [{ name: 'main', path: root }, { path: path.join(root, 'second') }],
  });
  projectId = r.body.project.id;
}, 30000);

afterAll(async () => {
  await m?.stop();
  await daemon?.stop();
});

describe('files', () => {
  it('flags entries git ignores, and .git itself; nothing outside a repository', async () => {
    const r0 = await api.get(`/api/projects/${projectId}/files?path=main`);
    expect(r0.body.entries.every((e: any) => e.ignored === false)).toBe(true);

    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'am-ignored-'));
    execFileSync('git', ['init', '-q', repo]);
    fs.writeFileSync(path.join(repo, '.gitignore'), 'dist/\n*.log\n');
    fs.mkdirSync(path.join(repo, 'dist'));
    fs.writeFileSync(path.join(repo, 'dist', 'bundle.js'), '');
    fs.writeFileSync(path.join(repo, 'app.log'), '');
    fs.writeFileSync(path.join(repo, 'index.ts'), '');
    const created = await api.post('/api/projects', {
      name: 'ignored',
      repos: [{ name: 'repo', path: repo }],
    });
    const id = created.body.project.id;
    const r = await api.get(`/api/projects/${id}/files?path=repo`);
    const flags = Object.fromEntries(
      r.body.entries.map((e: any) => [e.name, e.ignored]),
    );
    expect(flags).toEqual({
      '.git': true,
      dist: true,
      '.gitignore': false,
      'app.log': true,
      'index.ts': false,
    });
    // inside an ignored directory everything is ignored
    const inner = await api.get(`/api/projects/${id}/files?path=repo/dist`);
    expect(inner.body.entries).toMatchObject([
      { name: 'bundle.js', ignored: true },
    ]);
  });

  it('lists the repos at the root, then each repo with directories first and every entry typed', async () => {
    const root = await api.get(`/api/projects/${projectId}/files`);
    expect(root.status).toBe(200);
    expect(root.body).toMatchObject({
      path: '',
      entries: [
        { name: 'main', path: 'main', type: 'dir' },
        { name: 'second', path: 'second', type: 'dir' },
      ],
    });
    const r = await api.get(`/api/projects/${projectId}/files?path=main`);
    expect(r.status).toBe(200);
    expect(r.body.path).toBe('main');
    const names = r.body.entries.map((e: any) => `${e.type}:${e.name}`);
    expect(names.slice(0, 3)).toEqual(['dir:second', 'dir:src', 'dir:srclink']); // a symlink to a directory lists as a directory
    expect(names).toContain('file:.hidden');
    expect(names).toContain('symlink:outside');
    const readme = r.body.entries.find((e: any) => e.name === 'README.md');
    expect(readme).toMatchObject({
      path: 'main/README.md',
      type: 'file',
      size: 8,
    });
    expect(typeof readme.mtime).toBe('number');
  });

  it('lists nested directories by relative path and rejects leaving the project', async () => {
    const r = await api.get(
      `/api/projects/${projectId}/files?path=main/src/deep`,
    );
    expect(r.body).toMatchObject({
      path: 'main/src/deep',
      entries: [
        { name: 'note.txt', path: 'main/src/deep/note.txt', type: 'file' },
      ],
    });
    expect(
      (await api.get(`/api/projects/${projectId}/files?path=/main/src/`)).body
        .path,
    ).toBe('main/src');
    expect(
      (await api.get(`/api/projects/${projectId}/files?path=..`)).status,
    ).toBe(400);
    expect(
      (await api.get(`/api/projects/${projectId}/files?path=main/../..`))
        .status,
    ).toBe(400);
    expect(
      (await api.get(`/api/projects/${projectId}/files?path=nope`)).status,
    ).toBe(404);
    expect(
      (await api.get(`/api/projects/${projectId}/files?path=main/README.md`))
        .status,
    ).toBe(400);
    expect((await api.get(`/api/projects/nope/files`)).status).toBe(404);
  });

  it('reads text files, flags binary and oversized ones', async () => {
    const r = await api.get(
      `/api/projects/${projectId}/file?path=main/src/index.ts`,
    );
    expect(r.body).toMatchObject({
      path: 'main/src/index.ts',
      content: 'export const x = 1;\n',
      binary: false,
      truncated: false,
      size: 20,
    });
    expect(
      (await api.get(`/api/projects/${projectId}/file?path=main/blob.bin`))
        .body,
    ).toMatchObject({ binary: true, content: '' });
    expect(
      (await api.get(`/api/projects/${projectId}/file?path=main/big.txt`)).body,
    ).toMatchObject({
      truncated: true,
      content: '',
      size: 2 * 1024 * 1024 + 1,
    });
    expect(
      (await api.get(`/api/projects/${projectId}/file?path=main/src`)).status,
    ).toBe(400);
    expect(
      (await api.get(`/api/projects/${projectId}/file?path=main/missing.txt`))
        .status,
    ).toBe(404);
    expect(
      (await api.get(`/api/projects/${projectId}/file?path=../etc/passwd`))
        .status,
    ).toBe(400);
    // symlinks are followed; containment is deliberately not attempted
    expect(
      (await api.get(`/api/projects/${projectId}/file?path=main/outside`))
        .status,
    ).toBe(200);
  });

  it('requires a login', async () => {
    expect(
      (await new Api(m.url).get(`/api/projects/${projectId}/files`)).status,
    ).toBe(401);
  });
});
