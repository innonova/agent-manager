import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HARNESS_NOTE,
  loadHarnessTemplate,
  renderHarnessNote,
} from './harness.js';

const ctx = {
  agent: 'worker',
  project: 'demo',
  host: 'box',
  profile: 'claude',
  cwd: '/r/api',
  permissions: 'ask' as const,
  repos: [
    { name: 'api', path: '/r/api' },
    { name: 'ui', path: '/r/ui' },
  ],
};

describe('harness note', () => {
  it('fills the placeholders of the default note', () => {
    const note = renderHarnessNote(DEFAULT_HARNESS_NOTE, ctx)!;
    expect(note).toContain('agent "worker" of the project "demo" on box');
    expect(note).toContain('api (/r/api), ui (/r/ui)');
    expect(note).toContain('working directory is /r/api');
    expect(note).toContain('Permissions: ask.');
    expect(note).not.toMatch(/\{\{/);
  });
  it('keeps an unknown placeholder and turns an empty template into no note', () => {
    expect(renderHarnessNote('for {{agent}}: {{nope}}', ctx)).toBe(
      'for worker: {{nope}}',
    );
    expect(renderHarnessNote('  \n', ctx)).toBeNull();
  });
  it('reads the operator file when present, else the default', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-'));
    const file = path.join(dir, 'harness.md');
    expect(loadHarnessTemplate(file)).toBe(DEFAULT_HARNESS_NOTE);
    fs.writeFileSync(file, 'custom {{project}}');
    expect(loadHarnessTemplate(file)).toBe('custom {{project}}');
    fs.writeFileSync(file, '');
    expect(loadHarnessTemplate(file)).toBe(''); // present and empty: off
  });
});
