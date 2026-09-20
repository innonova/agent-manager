---
title: a per-project setting for when agents delegate
status: planned
priority: 45
---

**Purpose.** Some projects should not have agents starting other agents
unless a person has expressly asked for it in the conversation; others
are fine with an agent's own judgement. The rule about how to delegate
(the method, the framing) is the same everywhere; the rule about when
differs per project, and it has to reach the agent where the rest of
its situation reaches it, in the harness note, at session start.

**Requirements.**
- A project setting `delegation`, one of `free` (the default) and
  `on-request`, on the project record, accepted at creation and by the
  edit route, returned with the project.
- The harness note carries one line for it through a placeholder,
  `{{delegation}}`: nothing in a free project; in an on-request project
  "In this project, agents delegate only when a person has expressly
  asked for it in the conversation." The shipped `harness.md` places the
  placeholder under the project line; the method and the framing do not
  change.
- Nothing hard: an agent's token in an on-request project can still
  start a helper, since when a person does ask, it must be able to.
- The web UI's project form (create and edit) has a select for it with
  a sentence under it; the projects page shows "delegation on request"
  on the row only when set, and a restart of the project's agents
  carries the change into their notes (the form's "save and restart
  agents" already exists).
- The CLI: `am project new … --delegation on-request`, and
  `am project set <project> --delegation free|on-request`.

**Facts.** The harness context and its placeholders are in
`agent-manager/src/agents/harness.ts` (`renderHarnessNote`,
`HarnessContext`) and filled in `agents.service.ts` (`harnessNote`);
the project record is `src/projects/projects.service.ts` with columns
added in `src/db/db.service.ts`'s migration block; the project form is
`agent-manager-ui/src/components/ProjectForm.vue`, used by
`ProjectsView.vue`; the CLI's project commands are in
`agent-manager-cli/src/commands.ts` (`project new`, `add-repo`,
`restart`). The shipped note is `harness.md`; the placeholder test is
`harness.spec.ts` and asserts the note carries no imperatives, so the
sentence is a description of the project, not an instruction.
Operator files and their test overrides are not touched.

**Hard to verify.** That an agent restarted after the setting changes
reads the new line (the e2e can create an on-request project, start a
fake agent, and ask it for its note); that a free project's note has
no dangling blank line where the placeholder rendered nothing (the
note's blank-line collapsing covers it, assert it).

**Worth.** An hour across three repositories, no design in it.

**Gate.** Worked alone: each repository's full gate, one commit per
repository, no push, no deploy; a screenshot of the form; the
delegating agent looks and closes.
