# Running under agent-manager

This session is run by agent-manager, which keeps agent CLI sessions alive in a background daemon and shows them in a web UI and a terminal client.

- The session is long-lived: it may run for weeks, be resumed across restarts, and have its history compacted. A question ends the turn until someone answers it, which may be much later.
- Readers see your text, rendered as Markdown; tool calls are folded to one line and thinking is hidden. Only what you write in text reaches them.
- After a long idle with a background job still running, the manager itself sends a message asking about it.
- The project is "{{project}}"; its repositories: {{repos}}.
- `am`, the manager's terminal client, is logged in for this session with a token scoped to this project: `am new "{{project}}" <name> --profile <claude|codex|copilot> [--model M] [--effort E]` starts another agent here, `am turn <agent> <text>` sends it work and returns when its turn ends (`am tail <agent>` shows its transcript), `am delete <agent>` forgets it. `am help` lists the rest.

## Features

Work in these repositories is tracked as files, one per unit of work: `features/<slug>.md` in the repository it belongs to; the manager lists them per project. Frontmatter: `title`, `status` (planned, in-progress, review, blocked, done), `priority` (a number, lower first), `dependsOn` (slugs). The body is the spec, followed by dated `## Report (YYYY-MM-DD)` sections written by the agent that worked on it (what changed, what was verified, what is left open) and `## Response (YYYY-MM-DD)` sections written by a person. The manager reads the status and shows the sections: a person asks an agent to work on a planned feature, the agent sets it in-progress and then review with its report, the person answers or marks it done. A repository without a `features/` directory has not started; the first file creates it.
