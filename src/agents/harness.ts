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
  /** The project's delegation rule; renders a line only for `on-request`. */
  delegation: 'free' | 'on-request';
  /** Who created the agent: a person, or `agent-<name>` for a helper; null when unknown (agents from before the field). */
  startedBy?: string | null;
  /** For an agent on another machine: the hub's name, where the project's repositories live; `host` is then the agent's own machine. */
  hub?: string | null;
  /**
   * For an agent of a stream (`docs/streams.md`): its home, and the
   * clones in it when the session starts. `{{work}}`, `{{featureFiles}}`
   * and `{{featureStart}}` then describe a stream; without it, a project
   * and its repositories.
   */
  stream?: { home: string; clones: { name: string; path: string }[] } | null;
  /** The other machines an agent of this project can be started on, for `{{hosts}}`: nothing when there are none. */
  hosts?: { name: string; description?: string }[];
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
 * What the work is and where it lives: a project and its repositories,
 * or a stream. Facts, the way the rest of the note is facts: where
 * things are, who commits what, how work lands. The note's `{{work}}`,
 * and what an agent that was forked into somewhere else is told of the
 * place it is in now.
 */
export function describeWork(ctx: HarnessContext): string {
  const repos = ctx.hub
    ? `${ctx.repos.map((r) => `${r.name} (${r.path})`).join(', ')}, on the hub ${ctx.hub}. This session runs on ${ctx.host}, in ${ctx.cwd}; what the project's repositories hold is reached from here by git, not by path`
    : ctx.repos.map((r) => `${r.name} (${r.path})`).join(', ');
  const s = ctx.stream;
  return s
    ? `The work is the stream "${ctx.project}": a unit of work that is not tied to a repository. Its agents start in its home, ${s.home}, which is not a repository. \`stream/\` there is the stream's own folder: its instruction file (\`AGENTS.md\`, also what \`CLAUDE.md\` in the home leads to), its features, its docs. That folder is in a store the manager commits by itself, so files are written there with ordinary tools and git is not run in it. The stream's clones of the repositories it works on are the directories beside it: ${s.clones.length ? s.clones.map((c) => `${c.name} (${c.path})`).join(', ') : 'none yet'}. \`am use <repository>\` clones one from the manager's registry into the home and sets it up; \`am repos\` lists the registry and \`am clones\` what is in the home. A clone belongs to this stream alone: other streams work on the same repository at the same time in clones of their own, and the agents of one stream share its clones. Each clone has its own instruction file (\`CLAUDE.md\` or \`AGENTS.md\`) with that repository's commands, gate and hard rules, which hold for whoever works on it and are read before working there. Nobody owns a repository's main: a stream works on a branch named \`${ctx.project}/<topic>\` while its work is unstable and lands on main on its own judgement (rebase, the repository's gate on the result, push, and again if someone else got there first); what is deployed comes from main after landing. Whoever changes what a repository does updates its documentation in the same landing, and a commit made for a feature names it in a trailer, \`Feature: ${ctx.project}/<slug>\`. Commits in a clone are made under this machine's git identity as it is configured: which agent made a commit is the manager's to record, not the author line's. A stream that is finished is put away by a person and can be brought back: its folder and its agents are kept, and its clones come off the disk and are made again from their remotes when it returns, so what lasts in a clone is what was committed and pushed (a stream is not put away while commits exist only there).`
    : `The project is "${ctx.project}"; its repositories: ${repos}.`;
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
  // A remote agent's repositories are on the hub, not beside it; its own
  // directory is what it has.
  const repos = ctx.hub
    ? `${ctx.repos.map((r) => `${r.name} (${r.path})`).join(', ')}, on the hub ${ctx.hub}. This session runs on ${ctx.host}, in ${ctx.cwd}; what the project's repositories hold is reached from here by git, not by path`
    : ctx.repos.map((r) => `${r.name} (${r.path})`).join(', ');
  const s = ctx.stream;
  const values: Record<string, string> = {
    agent: ctx.agent,
    project: ctx.project,
    work: describeWork(ctx),
    featureFiles: s
      ? "The stream's work is tracked as files, one per unit of work: `stream/features/<slug>.md` in its home, whichever repositories the work touches; the manager lists them."
      : 'Work in these repositories is tracked as files, one per unit of work: `features/<slug>.md` in the repository it belongs to; the manager lists them per project.',
    featureStart: s
      ? 'A stream without a `features/` directory in its folder has not started; the first file creates it.'
      : 'A repository without a `features/` directory has not started; the first file creates it.',
    host: ctx.host,
    profile: ctx.profile,
    cwd: ctx.cwd,
    permissions: ctx.permissions,
    repos,
    startedBy: ctx.startedBy ?? 'a person',
    // Other machines, as a fact with a way to use it; the placeholder
    // collapses away when there are none, like the delegation line.
    hosts: ctx.hosts?.length
      ? `\n- An agent of this project can also run on another machine, its session there and the project here: ${ctx.hosts
          .map((h) => (h.description ? `${h.name} (${h.description})` : h.name))
          .join(
            '; ',
          )}. \`am new "${ctx.project}" <name> --host <machine> --cwd <an absolute path there>\` starts one; it works in that directory, usually a checkout of the project it keeps in sync itself, and reports here. \`am exec <machine> -- <command>\` runs one command there instead, in the session that machine's daemon runs in (the logged-in desktop on Windows, which an ssh login is not), and prints what came back; give the command as one quoted argument, or, when it has quotes of its own, on stdin: \`am exec <machine> <<'EOF'\` … \`EOF\`, which reaches that shell untouched.`
      : '',
    // A description of the project, not an instruction to the agent; nothing
    // for a free project, so its placeholder collapses away with no blank line.
    delegation:
      ctx.delegation === 'on-request'
        ? '\n- In this project, agents delegate only when a person has expressly asked for it in the conversation.'
        : '',
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
