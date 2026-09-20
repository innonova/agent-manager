---
title: a list of models, and what each is good at, for every project
status: done
priority: 55
---

Helpers run on different models, chosen by the agent that delegates or
by a person. The choice should be informed by what we have learned,
which today lives in people's heads and in one conversation. Keep it
where every project and every agent sees it: a `models.md` beside
`harness.md`.

- Shipped in the repository root as `models.md`, installed next to
  `dist/`, seeded into `~/.config/agent-manager/models.md` by the
  installer exactly as `harness.md` is (updated while unedited, kept
  once edited, the installer says which).
- Edited in the web UI on a page like `/harness` (the same editor and
  toolbar, generalised over the two files; the projects page block
  gets a second row), and readable through the API like the harness
  template (`GET`/`PUT /api/models`, a hub forwarding by host).
- Given to every agent: the harness note gets a `{{models}}`
  placeholder that renders the file's text, so a delegating agent
  chooses with the house view in front of it. The shipped harness
  note uses the placeholder under its own heading.
- Free text, Markdown, one section per model. The shipped text starts
  with what we know so far (2026-09-20): Claude Fable 5.1 and Codex's
  gpt-6-astra for UI design and anything with taste in it; Claude
  Sonnet 5 for wiring a designed UI up and for manager work with a
  tight spec, at a slower pace and with test-green-but-unlooked-at as
  its failure mode; Claude Opus 5 handled a manager round in ten
  minutes with an exact reading of the stream and an honest caveat,
  more to come. The run log (feature
  `run-log-for-model-comparison`) is where the evidence accumulates;
  this file is the conclusion, kept by hand.

Not in scope: anything automatic about model choice.

## Report (2026-09-20)

Done as planned in the plan turn, with the four answers folded in.

- **`models.md`** at the repository root: an intro naming it as the view
  an agent has when it picks a model for a helper, then a `###` section
  per model with the text from the spec (Fable 5.1 and gpt-6-astra for
  design and taste, Sonnet 5 for wiring up and tight-spec manager work
  with its green-but-unlooked-at failure mode, Opus 5's one measured
  round). It is held to the note's own standard by the unit test: no
  "never/always/do not/must" — description, not procedure.
- **`{{models}}`** in `src/agents/harness.ts` and at the end of the
  shipped `harness.md`. As agreed, the placeholder brings its own
  heading: it renders `## Models` plus the file's text, and nothing at
  all when the file is empty. A run of blank lines left behind by a
  placeholder that rendered nothing is collapsed, so "off" leaves no
  hole. The placeholder list in `docs/design.md` says this.
- **One implementation for both files.** `harness.controller.ts` became
  `note-files.ts` (a `NoteFileService` holding the read, the atomic
  write, the `source` verdict and the hub forwarding, parameterised by
  kind) and `note-files.controller.ts` (thin `HarnessController` and
  `ModelsController`). The row shape is unchanged, `template` and all —
  the misnomer is kept on purpose for the UI's single editor, and
  `docs/design.md` says so. `PUT /api/models` caps at 8 KB and the
  error says why ("it is pasted into every agent's note at session
  start"); the harness template keeps its 64 KB.
- **Config and installer.** `AGENT_MANAGER_MODELS_FILE`, `modelsFile`
  and `shippedModelsFile` in `src/config/config.ts`; the installer's
  three-way seeding became a `seed_config_file` function used for both
  files, and `models.md` is copied into the install directory (which is
  what "the previously shipped text" is compared against).
  `test/helpers.ts` points `modelsFile` at the test's data directory,
  so a test never reads or writes the developer's `~/.config`.
- **Decisions in the doc, not only here** (The harness note): an agent
  is told the house view in its note and nowhere else, frozen at
  session start, with `/api/models` refused to agent tokens as
  `/api/harness` is; both files are per machine, which fits the note
  but not the models and will not fit the run log either, so a
  hub-wide copy that spokes inherit is named as the later decision;
  nothing parses the file. `scopeAllows` is untouched.

Verified: `npm test` (79, including a new `harness.spec.ts` case for the
heading, the empty file and the no-hole rule) and `npm run lint` and
`tsc` pass. Two e2e tests were written and run on their own — `the
models file is read and written like the harness template, and lands in
the note` (`GET`/`PUT`, custom/off/built-in, the note carrying `##
Models` and losing it when the file is empty, 400 on a non-string, 400
with "8 KB" on an oversized body, 404 for an unknown host) and the
agent-token scope test extended with `/api/models` → 403. `README.md`'s
install list now names both seeded files.

Left open: the UI page (`agent-manager-ui`, not mine) — the API it needs
is the same shape as the harness one, so the existing editor
generalises over `kind`. The hub-wide copy is a decision, not a gap.

Gated with its batch: this is the first of two features in one context,
so it carries the cheap checks (unit, lint, tsc) and one commit; the
full `npm run test:e2e` is the batch's gate after
`run-log-for-model-comparison`, and whoever closes the batch pushes and
deploys. Not pushed, not deployed.
