---
title: a log of feature runs, for comparing models
status: review
priority: 60
---

We start delegating feature work to helpers on different models
(Sonnet, Opus, Codex, Bedrock). To learn which model is realistic for
which kind of work we need the runs on record, comparable, and kept
after the helper is forgotten. Today the pieces are scattered: the
feature's commit range is on the feature, the transcript is in the
daemon log (gone with `DELETE /api/agents/:id`), the model on the agent
row, the spend on the status.

A run is one agent's work on one feature: it begins when the feature
goes `in-progress` while that agent has a turn under way in the
project, and ends when the feature leaves `in-progress` (`review`,
`blocked`, `done`) or the agent's turn ends without that. The poller
already sees the transitions and records the feature's base commit; it
attributes the run to the working agent whose cwd is the feature's
repository, else the only working agent in the project, else none.

Record, in a `runs` table and a file per run under `<dataDir>/runs/`:

- agent id and name, profile, model, effort, permissions; the host;
- project, repository, feature slug, the status the feature ended in;
- started and ended at; the base and end commit of the repository (the
  end taken when the run ends, so a run that did not commit shows the
  same hash twice);
- the turn count and spend during the run (tokens in and out, dollars
  where the vendor prices them), as the difference of the agent's
  usage between start and end;
- the transcript of the run: the items between its first and last
  record, exported as NDJSON to the run's file at the end, so it stays
  when the agent is forgotten;
- the report the agent appended, as text.

API: `GET /api/runs` (filters: project, feature, model, since), `GET
/api/runs/:id` with the transcript, and the CLI `am runs [project]`
printing a table (feature, model, duration, commits, cost, outcome).
No UI page in this round; a block on the projects page can follow once
we know what we want to look at. Design doc: a Runs section.

Not in scope: judging quality. The log is the raw material; the
judgement is a person reading the transcript and the diff with the
numbers beside them.

## Report (2026-09-20)

Built as planned, with the five answers from the plan turn folded in.

- **`src/runs/`**: `RunsService` (opening, closing, the sweep, the
  export), `RunsController` (`GET /api/runs`, `GET /api/runs/:id`) and
  the module, registered in `app.module.ts`. The `runs` table went into
  the schema beside `feature_ranges`; `feature_runs` is still dropped
  at startup, as it was.
- **Opening.** `FeaturesService` gained an `onTransition` hook, called
  right after `recordRange` in both places a status change is noticed
  (the poller, and the human's own writes through `finish`). A hook,
  not a dependency, so the run log can depend on features without
  features depending on it — the same shape as the second hook this
  needed, `AgentsService.onBeforeRemove`. Attribution is the spec's:
  the agent working in the feature's repository, else the only agent
  working in the project, else no run at all, with a log line saying so.
- **Closing.** The feature leaving `in-progress` is the ordinary case.
  The nets are `onBeforeRemove` (awaited by `remove()` while the
  transcript is still readable — that ordering is why a hook was needed
  rather than the existing `removed` event, which fires after the cache
  is cleared), the `state` event when an agent exits, and a
  once-a-minute sweep for `AGENT_MANAGER_RUN_IDLE_MS` (default two
  hours, 0 disables). `outcome` records which of the four closed it.
  The sweep also closes runs whose agent vanished while the manager was
  down, which is what makes a restart safe.
- **Numbers.** The vendor's running totals (`usage.total ?? usage.spend`)
  are stored on the row at open and differenced at close, so the figure
  survives a restart of the manager. Every field is `null` when the
  vendor said nothing during the run.
- **Transcript.** `AgentsService.items(id, { from })` (cache plus
  resident tail) filtered to the window, written as `StoredItem` NDJSON
  to `<dataDir>/runs/<id>.ndjson` via temp-and-rename, kept
  indefinitely. `AgentsService.itemCount(id)` is new: the bookends.
- **Hub.** `GET /api/runs?project=<spoke>:<id>` forwards to that spoke
  and prefixes the ids it returns, and a prefixed run id forwards on
  `GET /api/runs/:id`, so a hub can read a spoke's log. An unfiltered
  listing is local; that is in the doc.

Verified: `npm test` (80, including a new `feature-file.spec.ts` case
for `lastReport`), `npm run lint` and `tsc` clean. A new
`test/runs.e2e-spec.ts` (2 tests, run on its own here; the suite runs at
the batch gate) drives the real thing against a git repository and the
fake profile: a feature goes planned → in-progress while an agent is
working → the run opens with the right agent, model and base commit →
the agent's steered message and turn end land in the window → the human
sets `review` → the run closes with `outcome: feature`, the end commit
of the commit it made, the report text, item bookends and a transcript
within them → the agent is deleted and the run and its transcript are
still there. The second test covers the two refusals: a transition with
nobody working records nothing, and an agent's own token gets 403 on
`/api/runs`.

Two things worth knowing, both now in `docs/design.md`:

- A run closed because the agent's process exited does not reopen when
  the agent resumes on its next turn; the next round of the feature is
  the next run. That follows from the net we agreed, and the
  alternative (reopening) would guess.
- The window is the agent's item indexes, so anything else that agent
  did while the run was open — a person talking to it — is in the
  transcript. Kept as specified, and said plainly rather than filtered.

Fixture: the fake agent grew a `linger` turn (stays working until
interrupted). The e2e needs an agent that is still working when the
poller notices a feature going in-progress a few seconds later, and
`slow` is both too short and pinned by an existing assertion on its
text length.

Not in this batch, as agreed: `am runs [project]` in
`agent-manager-cli`, and any UI page.

Gated with its batch: this is the second of two features in one
context; the cheap checks and one commit per feature, then the batch's
own gate (full `npm test`, `npm run test:e2e`, `npm run lint`) run after
this. Not pushed, not deployed.
