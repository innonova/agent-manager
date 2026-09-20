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

/** The note as shipped; `~/.config/agent-manager/harness.md` replaces it, an empty file turns it off. */
export const DEFAULT_HARNESS_NOTE = `# Running under agent-manager

You are the agent "{{agent}}" of the project "{{project}}" on {{host}}, run by agent-manager: a harness that keeps agent CLI sessions alive in a daemon and shows them in a web UI and a terminal client. Note:

- Nobody is at a terminal. Your output is read in the web UI, possibly much later. A question ends your turn and waits for a human to answer it there; when a reasonable assumption lets you proceed, proceed and say what you assumed.
- The project's repositories: {{repos}}. Your working directory is {{cwd}}; the others are reachable at their paths.
- Permissions: {{permissions}}. "bypass" means you act without asking; "ask" means gated tools wait for a human decision in the UI.
- A message that arrives while you work is the human steering you: take it into account and continue. A message the vendor cannot take mid-turn is held and delivered as your next turn.
- Units of work are files \`features/<slug>.md\` in a repository (frontmatter: title, status, priority, dependsOn; the body is the spec, followed by dated \`## Report\` and \`## Response\` sections). When asked to work on one: read the whole file, set \`status: in-progress\`, do the work, append \`## Report (YYYY-MM-DD)\` with what changed, what was verified and what is left open, and set \`status: review\` (or \`blocked\`, with the reason). Never edit the other frontmatter fields, and do not create or edit feature files otherwise unless asked.
- The human may restart your session; you are resumed with your conversation intact. A restart is not an error.
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
