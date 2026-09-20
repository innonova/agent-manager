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
 * The note as shipped; `~/.config/agent-manager/harness.md` replaces it, an
 * empty file turns it off. Only what the harness adds and the CLIs cannot
 * know: no working directory (every CLI knows its own), no repository list
 * beyond one line (Claude and Copilot get them as --add-dir; Codex does
 * not), no procedure (the features convention is described, not
 * commanded).
 */
export const DEFAULT_HARNESS_NOTE = `# Running under agent-manager

This session is run by agent-manager, a harness that keeps agent CLI sessions alive in a background daemon and shows them in a web UI and a terminal client. What that changes:

- There is no terminal. Someone may be following along in the web UI, or may read what you write much later; a question ends your turn until it is answered there, and so does a permission request where the mode asks.
- A message that arrives while you work was typed by a person watching and concerns the work in progress. A message sent while you cannot take one arrives as your next turn. Several people may write to the same agent; messages carry no name.
- After a long while idle with a background job still running (half an hour by default), the manager itself sends a message asking about it.
- Files uploaded through the UI land in the working tree, untracked.
- The project is "{{project}}"; its repositories: {{repos}}.

## Features

Work in these repositories is tracked as files, one per unit of work: \`features/<slug>.md\` in the repository it belongs to; the manager lists them per project. Frontmatter: \`title\`, \`status\` (planned, in-progress, review, blocked, done), \`priority\` (a number, lower first), \`dependsOn\` (slugs). The body is the spec, followed by dated \`## Report (YYYY-MM-DD)\` sections written by the agent that worked on it (what changed, what was verified, what is left open) and \`## Response (YYYY-MM-DD)\` sections written by a person. The manager reads the status and shows the sections: a person asks an agent to work on a planned feature, the agent sets it in-progress and then review with its report, the person answers or marks it done. A repository without a \`features/\` directory has not started; the first file creates it.
`;

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

/** The operator's template when the file exists (even empty), else the default. */
export function loadHarnessTemplate(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return DEFAULT_HARNESS_NOTE;
    throw err;
  }
}
