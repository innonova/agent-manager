import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('has documented defaults', () => {
    const c = loadConfig({ HOME: '/h' });
    expect(c).toMatchObject({
      host: '0.0.0.0',
      port: 4268,
      daemonUrl: 'ws://127.0.0.1:4267/',
      uiDir: null,
      adminPassword: null,
      secureCookie: false,
    });
    expect(c.dataDir.endsWith('/.local/state/agent-manager')).toBe(true);
  });
  it('parses overrides', () => {
    expect(
      loadConfig({
        AGENT_MANAGER_LISTEN: '127.0.0.1:1',
        AGENT_MANAGER_SECURE_COOKIE: '1',
        AGENT_MANAGER_ADMIN_PASSWORD: '',
      }),
    ).toMatchObject({
      host: '127.0.0.1',
      port: 1,
      secureCookie: true,
      adminPassword: null,
    });
    expect(() => loadConfig({ AGENT_MANAGER_LISTEN: 'x:y' })).toThrow(
      'invalid port',
    );
  });
});
