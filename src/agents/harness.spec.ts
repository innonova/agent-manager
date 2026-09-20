import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadHarnessTemplate,
  renderHarnessNote,
  shippedHarnessNote,
} from './harness.js';

/** The files shipped at the repository root, installed next to dist/. */
const SHIPPED = path.resolve(import.meta.dirname, '..', '..', 'harness.md');
const SHIPPED_MODELS = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  'models.md',
);

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
  delegation: 'free' as const,
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
    expect(note).toContain('started by a person'); // no creator on record
    expect(
      renderHarnessNote(shipped, { ...ctx, startedBy: 'agent-boss' }),
    ).toContain('started by agent-boss');
    expect(note).not.toContain('{{permissions}}'); // the CLI's own setting, not the harness's to state
    expect(note).toContain('features/<slug>.md');
    expect(note).not.toMatch(/\{\{/);
    // description, not procedure: the note tells the agent nothing to do
    expect(note).not.toMatch(/\b(never|always|do not|must)\b/i);
  });
  it('points at the method rather than carrying it', () => {
    const note = renderHarnessNote(shippedHarnessNote(SHIPPED), ctx)!;
    expect(note).toContain('am method');
    expect(note).toContain('am learn');
    // the method is a few pages: the note says where it is and stays short
    const method = fs.readFileSync(
      path.resolve(import.meta.dirname, '..', '..', 'method.md'),
      'utf8',
    );
    expect(method).toContain('## Bringing an agent in');
    expect(note).not.toContain('## Bringing an agent in');
    expect(note.length).toBeLessThan(method.length);
  });

  it('renders the models file under a heading of its own, or not at all', () => {
    const shipped = shippedHarnessNote(SHIPPED);
    expect(shipped).toContain('{{models}}'); // the note asks for it
    const models = shippedHarnessNote(SHIPPED_MODELS);
    expect(models).toContain('Claude Sonnet 5');
    const note = renderHarnessNote(shipped, { ...ctx, models })!;
    expect(note).toContain('## Models');
    expect(note).toContain('Claude Sonnet 5');
    expect(note).not.toMatch(/\{\{/);
    // the shipped models text is description too, like the rest of the note
    expect(note).not.toMatch(/\b(never|always|do not|must)\b/i);
    // the models file is the one thing an agent is told about models: it
    // is in the note and on no route of the API (see scopeAllows)
    const without = renderHarnessNote(shipped, { ...ctx, models: '' })!;
    expect(without).not.toContain('## Models');
    expect(without).not.toMatch(/\n\n\n/); // no hole where the section was
    expect(renderHarnessNote(shipped, ctx)).toBe(without); // no models at all: the same
  });

  it('carries the delegation line only for an on-request project, with no imperative and no dangling blank line', () => {
    const shipped = shippedHarnessNote(SHIPPED);
    expect(shipped).toContain('{{delegation}}');
    const free = renderHarnessNote(shipped, ctx)!;
    expect(free).not.toContain('agents delegate only when');
    expect(free).not.toMatch(/\{\{/);
    // the placeholder rendered nothing: no blank line where it was
    expect(free).toContain('.\n- `am`, the manager');
    expect(free).not.toMatch(/\n\n\n/);

    const onRequest = renderHarnessNote(shipped, { ...ctx, delegation: 'on-request' })!;
    expect(onRequest).toContain(
      'In this project, agents delegate only when a person has expressly asked for it in the conversation.',
    );
    // it sits directly under the project line
    expect(onRequest).toMatch(/its repositories:[^\n]*\.\n- In this project, agents delegate/);
    // description, not an instruction to the agent
    expect(onRequest).not.toMatch(/\b(never|always|do not|must)\b/i);
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
