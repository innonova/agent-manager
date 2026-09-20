import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadHarnessTemplate,
  renderHarnessNote,
  shippedHarnessNote,
} from './harness.js';

/** The file shipped at the repository root, installed next to dist/. */
const SHIPPED = path.resolve(import.meta.dirname, '..', '..', 'harness.md');

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
  it('fills the placeholders of the shipped note', () => {
    const shipped = shippedHarnessNote(SHIPPED);
    expect(shipped).toContain('# Running under agent-manager');
    const note = renderHarnessNote(shipped, ctx)!;
    expect(note).toContain(
      'The project is "demo"; its repositories: api (/r/api), ui (/r/ui).',
    );
    expect(note).toContain('The session is long-lived');
    expect(note).not.toContain('{{permissions}}'); // the CLI's own setting, not the harness's to state
    expect(note).toContain('features/<slug>.md');
    expect(note).not.toMatch(/\{\{/);
    // description, not procedure: the note tells the agent nothing to do
    expect(note).not.toMatch(/\b(never|always|do not|must)\b/i);
  });
  it('keeps an unknown placeholder and turns an empty template into no note', () => {
    expect(renderHarnessNote('for {{agent}}: {{nope}}', ctx)).toBe(
      'for worker: {{nope}}',
    );
    expect(renderHarnessNote('  \n', ctx)).toBeNull();
  });
  it('reads the operator file when present, else the shipped one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-'));
    const file = path.join(dir, 'harness.md');
    expect(loadHarnessTemplate(file, SHIPPED)).toBe(
      shippedHarnessNote(SHIPPED),
    );
    fs.writeFileSync(file, 'custom {{project}}');
    expect(loadHarnessTemplate(file, SHIPPED)).toBe('custom {{project}}');
    fs.writeFileSync(file, '');
    expect(loadHarnessTemplate(file, SHIPPED)).toBe(''); // present and empty: off
    expect(shippedHarnessNote(path.join(dir, 'missing.md'))).toBe(''); // no shipped file: no note
  });
});
