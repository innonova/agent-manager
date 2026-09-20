---
title: a list of models, and what each is good at, for every project
status: planned
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
