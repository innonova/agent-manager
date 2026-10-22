import { startDaemon, startManager, Api } from './helpers.js';
import type { TestDaemon, TestManager } from './helpers.js';

/** One command on a host through its daemon's shell profile; here the local host. */
let daemon: TestDaemon;
let m: TestManager;
let api: Api;

beforeAll(async () => {
  daemon = await startDaemon();
  m = await startManager(daemon.url, undefined, { hostName: 'here' });
  api = new Api(m.url);
  await api.login();
}, 30000);

afterAll(async () => {
  await m?.stop();
  await daemon?.stop();
});

describe('exec', () => {
  it('runs a command on this host and returns both streams and the exit code; the session is gone afterwards', async () => {
    const r = await api.post('/api/hosts/here/exec', {
      command: 'echo hello; echo oops >&2; exit 3',
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      host: 'here',
      exitCode: 3,
      stdout: 'hello\n',
      stderr: 'oops\n',
      timedOut: false,
    });
    expect(r.body.durationMs).toBeGreaterThanOrEqual(0);
    // cwd is honoured
    expect(
      (await api.post('/api/hosts/here/exec', { command: 'pwd', cwd: '/tmp' }))
        .body.stdout,
    ).toBe('/tmp\n');
    // unknown host, missing command
    expect(
      (await api.post('/api/hosts/nowhere/exec', { command: 'true' })).status,
    ).toBe(404);
    expect((await api.post('/api/hosts/here/exec', {})).status).toBe(400);
  });

  it('kills a command that outlives its timeout and says so', async () => {
    const r = await api.post('/api/hosts/here/exec', {
      command: 'echo started; sleep 30; echo never',
      timeoutMs: 1000,
    });
    expect(r.status).toBe(201);
    expect(r.body.timedOut).toBe(true);
    expect(r.body.stdout).toBe('started\n');
    expect(r.body.exitCode).toBeNull();
  }, 15000);
});
