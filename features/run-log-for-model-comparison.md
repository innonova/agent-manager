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

## Response (2026-09-20, agent-claude)

Third round. (1) The spend basis: record which basis was used at open (total or spend) and refuse to subtract unlike ones, reporting null; learnings entry #1 has the mechanism. (2) A run's spend should survive a manager reinstall, which is routine: consider recording the agent's usage at open and reading the close from the cached status rather than the live one when the live has been reset. (3) Review emits no event; the UI will want one when it shows runs. Plan first, verification first, as before.

## Report (2026-09-20)

Third round: the spend basis, the restore that makes it survive a
reinstall, one event, and the double prefix folded in as agreed.

**The basis (1) and the restore (2).** `src/runs/run-spend.ts` holds all
of it as pure functions: `snapshotOf(usage, sessionId)` takes a reading
on the widest basis the manager has and records *which* (`total` across
the agent's sessions, or the current session's `spend` alone), and
`runSpend(open, close)` subtracts only comparable pairs. It refuses
unlike bases, two `spend` readings from different sessions, and any
counter that went backwards; when it refuses, every field is null
including cost. Nothing at the close is null; nothing at the open means
the vendor first spoke during the run, so everything it has said
belongs to the run. `runs.service.ts` stores the richer snapshot in the
same `start_spend` column and tolerates a row written before this
existed (no basis → no starting point).

The restore is `restoreUsage` in `agents.service.ts`, called where the
transcript cache is loaded, with the content rule extracted as
`spendOnlyUsage` in `src/agents/usage.ts` so it can be stated exactly:
it puts back the session's `spend`, the agent's `total` across the
cached sessions, and the time of the report they came from; it leaves
out the rolling windows, the vendor's verdict, the plan, the context
and the provider, because spend only accumulates while a window
expires. It is a floor: the session's replay or the next vendor report
replaces it.

**The event (3).** `RunsService` is an `EventEmitter`; `announce` fires
`changed` on open, on close and on review, and the gateway broadcasts
`run.changed { projectId, run }` carrying the run as it now stands.
`RunsModule` is `@Global` now, like the agents and features modules and
for the same reason — the gateway listens to all three.

**The double prefix.** `hub.call` already rewrites the ids in a reply,
and a run carries `profile`, `projectId` and `id`, which is exactly what
that rewriting takes for an agent — so the controller's own `prefix()`
made `vibe:vibe:<id>`. The helper is gone and the hub test it never had
is there.

**Verified.** Unit: `run-spend.spec.ts` (9 — the basis of a reading,
same-basis subtraction, total-vs-spend refused both ways, different
sessions refused, a counter going backwards, the vendor first speaking
during the run, nothing at the close, an old-shaped row, and no partial
answer about money) and `usage.spec.ts` (3 — what the restore puts back
and what it leaves out). E2e: `test/run-restart.e2e-spec.ts` builds an
agent with spend on two sessions (asserting the `total` precondition
explicitly, so the file fails as a fixture problem rather than passing
vacuously), opens a run, restarts the manager on its own data
directory, and closes the run — once with the transcript cache intact
and once with it deleted, where the figures are rebuilt from the daemon
log instead. Both report the one priced turn inside the run:
1 turn, 30 000 in, 300 out, $0.30. `runs.e2e-spec.ts` now watches
`run.changed` on open, close and review; `hub.e2e-spec.ts` reads a
spoke's run log, fetches a run by its prefixed id and reviews it there.

**What I could not verify end to end, and why it is not a gap.** I
could not construct an unlike-basis pair in a live system any more. The
manager rebuilds an agent's sessions from the daemon log when the cache
is gone, and the one remaining way to widen the basis mid-run — the
agent exiting and resuming — closes the run first, by the rule from the
previous round. That is evidence the fix works rather than a hole in
the tests: the refusals are proven exactly by the unit spec, and the
e2e proves that after the restore the ordinary reinstall no longer
produces them. The real `npm run install:service` cannot be tested at
all, since it ends every session on this machine.

### Noticed, left alone

- **Deleting an agent's earlier `agent_sessions` rows does not make the
  manager forget them**: it re-adopts what the daemon still holds under
  the agent's label and replays it. Good for the spend, and worth
  knowing before anyone tries to prune an agent's history through the
  database.
- **The restore only fires when the cache is loaded.** An agent whose
  transcript cache is missing *and* whose daemon sessions are gone has
  no spend until it next reports — correct, but it means the floor is
  the cache's, not the database's. A row on `agents` would outlive both.
- **`runs` still has no index on `model` or `slug`**, and the list is
  capped rather than paginated.
- **`run.changed` goes to every authenticated socket**, agent tokens
  included, like `agent.state` before it. That is the existing norm
  rather than a new decision, and it is now in the doc.
- **`GET /api/learnings` parses the whole file on every call** (from the
  round before).
- **The transcript export still writes the window of an abandoned run**,
  after which the agent's later work belongs to no run until the feature
  moves.

Gated alone (a batch of one): cheap checks and this commit, then the
full gate below. Not pushed, not deployed.

## Response (2026-09-20, agent-claude)

Fourth round: the close is at the wrong moment. A run closes when the feature leaves in-progress, which in a real round is inside the agent's turn, so the vendor's cost report and the commit both land after the close: every run so far reads zero spend and, but for one that raced the other way, no commit (learnings #32, #16). Purpose: a run's numbers and commit range must be those of the round. Requirement: a run whose feature left in-progress closes at the end of the turn in which that happened (the agent's next turn end, or its exit or deletion as before), taking the spend and HEAD then; the feature's final status is still the one the poller saw. Fact: the fake agent's 'note'/'commit' turns and the existing run e2e give the shape; the settle at turn end in agents.service.ts is where the turn's end is known. Worth: a small round. Plan first, verification first.

## Report (2026-09-20)

**What changed.** A run no longer closes when the feature leaves
`in-progress`; it closes at the end of the turn in which that happened.

- *The fixture first, because nothing could be proven without it.* The
  fake agent reported its `usage` line at the **start** of a turn, where
  every real vendor reports the cost with the result. `fixtures/fake-agent.mjs`
  now holds it in `pendingUsage` and bills in `finish()` (and before the
  permission branch's own result), which is what makes the ordering in
  #32 reproducible at all.
- `src/runs/runs.service.ts`: `closeForFeature` records the status the
  poller saw (`closing_status`, `closing_at`) and leaves the run open
  while the attributed agent is in a turn — `working`, or
  `waiting-permission`, which is the middle of one. The `state`
  listener closes those runs when the agent leaves its turn, taking the
  spend and HEAD then. A feature returning to `in-progress` cancels the
  pending close, so one round stays one run. An agent that exits or is
  forgotten mid-pending closes with that outcome and the status already
  recorded. The sweep makes any pending close whose agent is no longer
  in a turn, which is what carries a restart of the manager.
- `src/db/db.service.ts`: the two columns, with the `ALTER` path beside
  the review ones. `Run` gained `closing`, null unless a close is
  pending, so the API and the `run.changed` frame show a run waiting.
- `docs/design.md`: the Runs section says when a run closes and why not
  at the moment the feature moved, including the edge you accepted —
  a person moving the feature while the agent works on something else
  puts that turn's cost in the run.

**What was verified.** The manager's full gate: `npm test` 120,
`npm run test:e2e` 120 across 13 files, `npm run lint` clean but for the
pre-existing `smoke-agents.mjs` warning, `tsc`, `nest build`,
`prettier --check`. Three new e2e cases carry the round:

- *the real round's shape* — the agent bills and lingers, the feature
  goes to `review` inside the turn, the commit lands after that, the
  poller sees `review` while the agent still works: the run stays open
  with `closing: 'review'`, and when the turn ends it closes with
  `turns: 1`, `costUsd: 0.1`, `inputTokens: 10000` and the end commit
  made after the status change. I checked this test bites: with
  `midTurn` forced to false — the old behaviour — it fails, and it is
  the only test that does;
- *one round, one run* — the feature going back to `in-progress` while
  the close is pending cancels it, leaving a single open run;
- *a close pending when the manager went down* — the turn ends while it
  is stopped, and the next sweep after the restart makes the close with
  the status the poller had seen.

The two sibling repositories were gated because the fake agent is
shared: `agent-manager-cli` 10 unit and 7 e2e, `agent-manager-ui` 4 unit
and 23 Playwright, both lint-clean. Neither needed a change, so neither
has a commit: the fixture's new timing is invisible to every test that
waits for a state or a chip rather than for the order of two lines.

**What is left open.** Nothing in the feature. Runs recorded before
today keep their zero spend; the two the finding named (`b4ec1ce3`,
`4b5e2808`) are wrong on the record and I have not touched them — a
correction would have to be a person's note on the review, since the
manager cannot recover what it never read.

**Noticed, left alone.**

- *The fixture had been hiding the bug from the tests that were meant
  to catch it.* Every run e2e written in the three earlier rounds
  passed while the product was closing runs before their cost existed,
  because the fake billed early. A fixture that is more convenient than
  the thing it stands for makes green tests that mean nothing; this is
  the second time the fake's timing has mattered (the first was the
  throttle, commit `fd5f9e4`). Worth an entry when you next curate.
- *`closing_at` is recorded and nothing reads it.* I kept it because a
  run that waited minutes for a turn to end is the first thing I would
  want to see if this rule ever behaves oddly, but today it is a column
  with no reader.
- *The idle sweep and a pending close can both be true.* A pending
  close is made before the idle timeout is considered, so a run cannot
  be abandoned while it waits — but that ordering lives in one `if`
  before the other, not in a name, and a future edit could swap them
  without a test noticing.
- *An agent blocked on a permission holds a pending close open.* That
  is deliberate — it is mid-turn — but with an unanswered permission
  the run waits until the sweep abandons it hours later, and the
  abandoned run then reports the feature status it was closing to.
  Correct on both counts, and unobvious enough to be worth knowing.

Worked alone, as briefed: one commit here, none in the siblings, each
repository gated. Not pushed, not deployed.
