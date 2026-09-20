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

## Response (2026-09-20, agent-claude)

Second round, from your own debrief and a review of it. (1) The sweep: a run's idle clock must not be reset by the manager's own background poke (the turn it sends an idle agent with pending jobs), or an agent in that state keeps a run open forever; base idleness on the agent's own turns (a turn end, an item it produced), not on lastActivityAt as it stands, and say in the doc what counts. (2) The review outcome: the log records cost and output but not whether the work was accepted or sent back, which is the column a comparison of models needs most. Add a review to a run: outcome accepted | sent-back, and when sent back a cause of model | brief | doc (the model did it wrong; the brief was wrong or thin; a fact the repository's docs should have carried was missing), with a free-text note and who reviewed; PUT /api/runs/:id/review, a hub forwarding by prefix, agent tokens allowed for their own project's runs (the delegating agent is the usual reviewer). am runs shows it; the CLI's part (am runs review <id> --outcome … --cause … --note …) is named in the report for the CLI repo. (3) The plan turn for this round includes what will be hard to verify, and how, before the how of the code. Gated as a batch of one: cheap checks, commit, then the full gate. Do not push or deploy.

## Report (2026-09-20)

Second round: the idle clock, the review, and the plan turn that put
verification first (`docs/method.md` had landed by then, so point 3 was
already done and I left both documents alone).

**The idle clock (1).** The literal reading of the point would not have
fixed it: a poke is a real turn, and the agent's answer to it is "an
item it produced", so filtering user items changes nothing. What had to
be excluded is the whole turn a poke opens. Three parts:

- `MANAGER_AUTHOR` in `agents.service.ts`: the poke now sends its turn
  as the manager, recorded in `turn_authors` under the reserved id
  `manager` (no users row; `attribute()` reads the id first and only
  joins `users` for a real one), so the transcript says who asked and a
  replay keeps the marker.
- `src/runs/run-activity.ts`: `lastOwnActivity(items)`, pure, over a
  tail of the transcript. Text, thinking, tool calls and results,
  errors, a permission asked for and a turn's end count; a message
  anyone sent, the harness's system lines, and everything between a
  poke's user item and the `turn_end` that closes it do not.
- `RunsService.sweep` uses it instead of `status.lastActivityAt`,
  falling back to the run's own start when the agent has done nothing
  of its own since it opened — which is exactly the stalled case. The
  clock does not run while the agent is `working` (not idle) or
  `waiting-permission` (blocked on a human, as agreed). The sweep
  interval derives from `runIdleMs` so a short timeout is checked often
  enough to be tested.

**The review (2).** Five columns on `runs` with an `ALTER` path, since
the table shipped last round; `RunsService.review()` validates (a cause
is required when sending back, refused when accepting, note capped at
8 KB), replaces an earlier verdict and re-stamps the time; `PUT
/api/runs/:id/review` in the controller, forwarding a prefixed id to
its spoke like the two GETs. `scopeAllows` was touched only for this:
the existing runs branch now also allows `PUT .../review` for a run of
the token's project. An agent reviewing appears as `agent-<name>`,
which reads correctly in the log.

**Verified.** The poke rule is carried by unit tests, not by the e2e,
and deliberately: `src/runs/run-activity.spec.ts` (6 cases) states it
exactly — pokes only, work then pokes, a poke still running, a turn the
agent started by itself after a background job, permissions and errors.
An e2e could only have shown the poke *delaying* abandonment by a
second or two, which is a timing assertion I would not want to carry.
`test/run-idle.e2e-spec.ts` (its own manager, `runIdleMs` 4 s,
`backgroundPokeMs` 1.5 s, because a four-second timeout would abandon
the other file's runs while they wait for the poller) covers the path:
a quiet agent's run is abandoned with the feature still in progress and
nothing reopens it; a working agent's run survives past the timeout,
and once it is idle with a background job pending it is abandoned
anyway, with the poke on record attributed to `manager`.
`test/runs.e2e-spec.ts` gained the review: the verdicts, all five
validation refusals, 404 for an unknown run, replacement of an earlier
verdict, an agent token reviewing a run of its project, and an agent of
another project refused. `npm test` 86, `npm run test:e2e` and
`npm run lint` at the gate below.

**One change outside the feature, with permission:** the background
watchdog's interval in `agents.service.ts` now derives from
`backgroundPokeMs` the same way the sweep derives from `runIdleMs`
(`max(1s, min(60s, interval/2))`), so a test can see a real poke.
Expected fallout, also outside: `test/permissions.e2e-spec.ts`
asserted the poke's user item had *no* author; it now asserts `by ===
'manager'`. Same fact, stated positively.

**Left open.** The e2e does not prove that repeated pokes never reset
the clock, because the fake agent answers the first poke by reporting
the job finished, which stops the poking. Proving it end to end would
need a fixture that keeps a job pending, and the unit tests already
state the rule exactly. Nothing aggregates the review yet — counting
causes per model is the reading, not the recording, and stays out per
"not in scope: judging quality".

### Noticed, left alone

- **`am runs review` does not exist yet** (`am runs` landed in the CLI
  as `ef58b6c`). Until it does, an agent reviewing a run has to `PUT`
  the route by hand, which is exactly the friction the method's
  "closing the loop" step assumes away. The CLI's part.
- **The reserved author id is a string in a column of user ids.**
  `turn_authors.user_id` has no foreign key, so `manager` sits there
  beside real user ids and every reader has to know the exception. It
  is one line in `attribute()` today; a second such author (a scheduler,
  a webhook) would want a proper column.
- **`GET /api/runs/:id/review` is allowed by the scope check** although
  no such route exists — the branch permits `GET` on both paths for
  tidiness, and the router answers 404. Harmless, slightly untidy.
- **The review has no event.** `feature.changed` and `agent.state` are
  announced; a review changes a run and nothing hears it. Fine while
  there is no UI page, worth remembering when there is one.
- **The `runs` table still has no index on `model` or `slug`**, and the
  list is capped rather than paginated (noted last round, unchanged).
- **The transcript export writes the window even when a run is
  abandoned**, which is right, but an abandoned run of an agent that
  then keeps working has a window ending at the abandonment: the later
  work belongs to no run at all until the feature moves. Whether that
  gap matters depends on how often runs are abandoned in practice; the
  log will show it.

Gated alone (a batch of one, as briefed): cheap checks and this commit,
then the full gate below. Not pushed, not deployed.
