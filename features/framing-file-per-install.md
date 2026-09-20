---
title: the framing document ships beside the method
status: planned
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
