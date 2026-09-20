import fs from 'node:fs';

/**
 * What an agent is told about running here. The vendors' CLIs know
 * nothing about the manager: nobody is at a terminal, messages may
 * arrive mid-turn, the features convention exists. Each vendor has a
 * per-process channel for instructions (Claude: --append-system-prompt;
 * Codex: developerInstructions on thread/start and thread/resume;
 * Copilot: an instructions file in a directory named by
 * COPILOT_CUSTOM_INSTRUCTIONS_DIRS), so the note is supplied at every
 * session start and a changed note reaches an agent at its next restart.
 */
export interface HarnessContext {
  agent: string;
  project: string;
  host: string;
  profile: string;
  cwd: string;
  permissions: 'bypass' | 'ask';
  repos: { name: string; path: string }[];
  /**
   * The house view of the models (`models.md`), for `{{models}}`: what we
   * have learned about which model suits which work, so an agent that
   * delegates chooses with it in front of it. The text as the operator
   * keeps it; the heading around it belongs to the note.
   */
  models?: string;
}

/**
 * The note as shipped: `harness.md` at the repository root, installed next
 * to `dist/`. The installer copies it to `~/.config/agent-manager/harness.md`
 * when there is none, and that copy is what runs; a missing copy falls back
 * to the shipped file, an empty one turns the note off. Read on every call,
 * so an edit needs no restart.
 */
export function shippedHarnessNote(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Fills the placeholders; an unknown placeholder is left as is.
 * Whitespace-only text means no note. `{{models}}` is the one
 * placeholder that brings its own heading: it renders `## Models` and
 * the file's text, or nothing at all when the file is empty, so turning
 * the models file off leaves no empty section behind.
 */
export function renderHarnessNote(
  template: string,
  ctx: HarnessContext,
): string | null {
  if (template.trim() === '') return null;
  const values: Record<string, string> = {
    agent: ctx.agent,
    project: ctx.project,
    host: ctx.host,
    profile: ctx.profile,
    cwd: ctx.cwd,
    permissions: ctx.permissions,
    repos: ctx.repos.map((r) => `${r.name} (${r.path})`).join(', '),
    models: ctx.models?.trim() ? `## Models\n\n${ctx.models.trim()}` : '',
  };
  const note = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key: string) =>
    key in values ? values[key] : m,
  );
  // A placeholder that rendered nothing (an empty models file) leaves the
  // blank lines around it behind; a run of them is one blank line.
  return note.replace(/\n{3,}/g, '\n\n');
}

/**
 * The operator's file when it exists (even empty), else the shipped one.
 * The harness template and the models file are read the same way: an
 * edit needs no restart, and an empty file turns the thing off.
 */
export function loadHarnessTemplate(file: string, shipped: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return shippedHarnessNote(shipped);
    throw err;
  }
}
