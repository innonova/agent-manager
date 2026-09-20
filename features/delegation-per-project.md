---
title: a per-project setting for when agents delegate
status: review
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

## Report (2026-09-20)

**What changed.**

*agent-manager.* A `delegation` column on projects (`free` default, or
`on-request`), migrated in `db.service.ts` and in the CREATE TABLE for
fresh installs; validated and threaded through `projects.service.ts`
(create, update, `toProject`, a `parseDelegation` guard, the `Delegation`
type and `Project.delegation`). The controller already passes the body
through, so create and edit carry it with no controller change, hub
create included. The harness note gains a `{{delegation}}` placeholder
(`harness.ts`): one bullet under the project line for an on-request
project — "In this project, agents delegate only when a person has
expressly asked for it in the conversation." — and nothing for a free
one, appended to the project line so a free project has no dangling
blank line (no reliance on the collapse rule, though it still runs).
`agents.service.ts` reads the project's delegation into the context at
session start (defaulting to free if the project is gone). The shipped
`harness.md` places the placeholder; the method and framing are
untouched, as the spec required. Docs: the domain model, the harness
placeholder list, and the create route in `docs/design.md`.

*agent-manager-ui.* `ProjectForm.vue` (create and edit) gains a
Delegation select with a sentence under it; `ProjectsView.vue` seeds it
(`empty`, `openEdit`), submits it, and shows an amber "delegation on
request" badge on the row only when set; `Project.delegation` and the
create/update input types in `api/types.ts`, `api/client.ts` and the
projects store.

*agent-manager-cli.* `am project new … --delegation on-request` and a new
`am project set <project> --delegation free|on-request` (with a
`parseDelegation` guard, help text, and the "needs new, add-repo, set or
restart" line); `delegation` on the create/update client types and the
`Project` type.

**What was verified, and how.**
- *agent-manager* full gate: `npm run build` clean; `npm test` 118 unit
  (a new `harness.spec.ts` case: the on-request bullet sits under the
  project line, is a description not an imperative, and a free note has
  no dangling blank line); `npm run test:e2e` 127 e2e (a new
  `manager.e2e-spec.ts` case: an on-request project's note carries the
  line, a free one does not, a restart after editing the setting picks
  up the change, and a bad value is 400); `npm run lint` clean (the one
  warning is pre-existing in `scripts/smoke-agents.mjs`).
- *agent-manager-ui* full gate: `npm run test:unit` 12; `npm run lint`
  clean (0 errors; two pre-existing `waitForTimeout` warnings in
  `app.spec.ts`, not this feature's); `npm run build` clean;
  `npm run test:e2e` 26 (project create/edit still pass with the new
  select).
- *agent-manager-cli* full gate: `npm run build` clean; `npm test` 10
  unit; `npm run test:e2e` 8 (a new case: `--delegation on-request` at
  creation, `project set --delegation free`, and a bad value refused as
  a usage error); `npm run lint` clean.
- The form screenshot (a throwaway Playwright capture, since deleted) is
  at `/tmp/delegation-shots/project-form-light.png`: the New project
  form with Delegation on "on request" and its sentence.

**What is left open.** Nothing in scope. Not pushed, not deployed, per
the gate: the delegating agent looks at the form and closes.

**What I noticed and left alone.**
- I skipped setting the feature `in-progress`, as the round was small and
  the plan was skipped; it goes planned → review here. No run opened
  (there was no helper agent), so nothing depended on the transition.
- The setting reaches an agent only at its next session start, like the
  rest of the note; the UI's "save and restart agents" and `am project
  restart` are how a change is carried into running agents, as the spec
  says. Not made automatic, deliberately.
- The badge and the note say "on request" only; a free project shows and
  says nothing, matching the note's own silence.

Gated alone, all three repositories.
