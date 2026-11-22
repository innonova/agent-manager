import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDaemon, startManager } from './helpers.js';
import type { TestDaemon, TestManager } from './helpers.js';

/**
 * A second UI under /next/, beside the first: the one being built for
 * streams is served there while the current one stays at /.
 */
let daemon: TestDaemon;
let m: TestManager;

const get = (p: string, accept = 'text/html') =>
  fetch(m.url + p, { headers: { accept } }).then(async (r) => ({
    status: r.status,
    text: await r.text(),
  }));

beforeAll(async () => {
  daemon = await startDaemon();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-two-uis-'));
  for (const [name, mark] of [
    ['ui', 'the first'],
    ['ui-next', 'the second'],
  ] as const) {
    fs.mkdirSync(path.join(dir, name, 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, name, 'index.html'),
      `<html>${mark}</html>`,
    );
    fs.writeFileSync(path.join(dir, name, 'assets', 'app.js'), `// ${mark}`);
  }
  m = await startManager(daemon.url, undefined, {
    uiDir: path.join(dir, 'ui'),
    uiNextDir: path.join(dir, 'ui-next'),
  });
}, 30000);

afterAll(async () => {
  await m?.stop();
  await daemon?.stop();
});

describe('two UIs', () => {
  it('serves each under its own address, deep links included, and the API under both', async () => {
    expect((await get('/')).text).toBe('<html>the first</html>');
    expect((await get('/projects/abc')).text).toBe('<html>the first</html>');
    expect((await get('/assets/app.js', '*/*')).text).toBe('// the first');
    for (const p of [
      '/next/',
      '/next',
      '/next/a/1234',
      '/next/login?next=/a/1',
    ])
      expect([p, (await get(p)).text]).toEqual([p, '<html>the second</html>']);
    expect((await get('/next/assets/app.js', '*/*')).text).toBe(
      '// the second',
    );
    // a path that only starts like it is the first one's
    expect((await get('/nextdoor')).text).toBe('<html>the first</html>');
    expect((await get('/api/health', 'application/json')).status).toBe(200);
  });
});
