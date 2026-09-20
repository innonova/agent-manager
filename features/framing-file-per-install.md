---
title: the framing document ships beside the method
status: review
priority: 55
---

**Purpose.** The method split in two on 2026-09-20: `method.md` is the
steps, `framing.md` is how to write a feature and a brief. A person and
an agent should be able to read and edit both the way they read and
edit the method today, and an agent should get the framing text with
`am framing` the way it gets the method with `am method`. The result is
a second note file on every install, indistinguishable in handling
from the first.

**Requirements.**
- `framing.md` at the repository root ships and seeds exactly like
  `method.md`: installed next to `dist/`, seeded into the config
  directory by the three-way rule, `GET`/`PUT /api/framing`, a hub
  forwarding by host, agent tokens allowed to read.
- `am framing` prints it; `am method` is unchanged.
- The web UI edits it at `/framing` on the note-file page and lists it
  in the projects page's Method block beside the method.
- The harness note's line about `am method` mentions `am framing` in
  the same breath.
- Nothing about the method or the models file changes.

**Facts.** The method file went through this exact plumbing this
afternoon (commit d3543bd): config, `note-files.ts` KINDS,
`note-files.controller.ts`, the installer's `seed_config_file` and its
copy line, `test/helpers.ts` overrides, the CLI and UI test backends
(`AGENT_MANAGER_*_FILE`), the UI router and `HarnessView.vue` kinds,
`ProjectsView.vue`'s block, the CLI's `am method` in `commands.ts`.
Learnings #2 is the lesson: an operator file has to be added in the
config, the installer and every test override at once, or a test
writes into the developer's real config directory. The three
repositories are `agent-manager`, `agent-manager-cli` and
`agent-manager-ui`, siblings at `../`; each has its own gate
(`npm test`, `npm run test:e2e`, `npm run lint`; the UI's Playwright
suite owns port 4299, one run at a time; the CLI's e2e runs against
`../agent-manager/dist`, so build the manager first).

**Worth.** A mechanical round: about the size of the method file's
own, which was one turn. If it grows past that, stop and say why.

**Gate.** Worked alone: each repository's full gate, one commit per
repository, no push, no deploy; the delegating agent closes the gate
and deploys the three together, since the harness note will promise
`am framing` from the moment the manager restarts.

## Report (2026-09-20)

**What changed.** The framing is a second note file of the method's
kind, in all three repositories.

- *agent-manager*: `framingFile`/`shippedFramingFile` and
  `AGENT_MANAGER_FRAMING_FILE` in the config; a fourth entry in
  `note-files.ts`'s `KINDS` and its `files()`; `FramingController`
  beside the other three; `scopeAllows` lets an agent's token `GET`
  `/api/framing` as it does `/api/method`, and no more; the installer
  seeds `framing.md` with `seed_config_file` and copies it next to
  `dist/`; `test/helpers.ts` overrides `framingFile`; the harness note's
  `am method` line now names `am framing` in the same breath;
  `docs/design.md` gains a paragraph beside the method's, the two API
  lines, the config row and the agent-token sentence.
- *agent-manager-cli* (`7afdaa3`): `api.framing()`, `am framing` sharing
  the method's case, the help line, and the command list in
  `docs/design.md`.
- *agent-manager-ui* (`06c5fad`): a `NoteFileKind` type in `api/types.ts`
  that the client and the view now take instead of three literals, the
  `/framing` route, a fourth kind in `HarnessView.vue` with its own
  label and footer paragraph, and the projects page's Method block
  carrying the framing's source and its view/edit link beside the
  method's.

**What was verified.** Each repository's full gate, run in its own
checkout after the change.

- agent-manager: `npm test` 113, `npm run test:e2e` 117, `npm run lint`
  clean (the one pre-existing `smoke-agents.mjs` warning), `tsc`,
  `nest build`, `prettier --check`. The e2e covers the new route where
  the method's was covered: a hub reading and writing `/api/framing` on
  both machines, and an agent's token reading it and being refused the
  `PUT`.
- agent-manager-cli: `npm test` 10, `npm run test:e2e` 7 (against the
  manager built from this change), `npm run lint`, `tsc`,
  `prettier --check`. `am framing` is asserted on the shipped text.
- agent-manager-ui: `npm run test:unit` 4, `npm run test:e2e` 23
  Playwright, `npm run lint`, `npm run build`, `npm run format`. The
  harness-note test now walks projects → method → projects → framing,
  each showing "the shipped text" and its own document in the editor.

Three assertions in three repositories were reading texts that
`d5d940e` rewrote this afternoon, two of them through the developer's
real `~/.config` files; all three are fixed and the two backends that
were reading the real files no longer can (below).

**What is left open.** Nothing in the feature. The three commits are
not pushed and nothing is deployed: the harness note promises
`am framing` from the moment the manager restarts, so the three want
deploying together, which is yours to do. The UI's Playwright test
asserts the framing page by a phrase from the shipped text, so a
rewrite of `framing.md` will break it exactly as the three above broke
— the same class of coupling, not worth a second mechanism today.

**Noticed, left alone.**

- *Learnings #2 had two more instances, in the two repositories that
  test against the manager.* The CLI's `test/backend.ts` and the UI's
  `e2e/backend.mjs` set `AGENT_MANAGER_HARNESS_FILE` and
  `AGENT_MANAGER_MODELS_FILE` and nothing else, so every test of
  `am method` and of the method page has been reading — and the UI's
  could have written — the developer's real
  `~/.config/agent-manager/method.md`. Both now point every operator
  file at their own temp root. The rule has grown: a new operator file
  is six places, not three (manager config, installer, manager test
  helpers, CLI test backend, UI e2e backend, UI kinds and routes).
- *The shipped documents are asserted by content in three
  repositories*, none of which contains them but one. Rewriting a
  document is therefore a cross-repository test break with no signal
  until the gate runs somewhere else.
- *`npm run format` in the UI reformatted `src/components/ActivityLine.vue`*,
  which I had not touched: an earlier commit left it unformatted and
  the tailwind class order is prettier's. It rode along in `06c5fad`
  rather than being left to fail the next person's format run.
- *An agent may read the method and the framing but not the harness
  note or the models file.* Deliberate and documented, and it means an
  agent cannot read the note it was itself given through the API —
  `agent.harnessNote` carries it, so nothing is missing today.
- *`framing.md` says the person's statement of the project's purpose
  "does not exist yet"* — still true after this round; nothing here
  creates it.

Worked alone, as briefed: one commit per repository, each gated on its
own. Not pushed, not deployed.
