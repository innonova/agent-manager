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

/** Fills the placeholders; an unknown placeholder is left as is. Whitespace-only text means no note. */
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
  };
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key: string) =>
    key in values ? values[key] : m,
  );
}

/** The operator's template when the file exists (even empty), else the shipped one. */
export function loadHarnessTemplate(file: string, shipped: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return shippedHarnessNote(shipped);
    throw err;
  }
}
