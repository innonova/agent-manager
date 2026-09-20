# Working with agents: the method

How work is given to agents here, how agents give work to other agents,
and how the results are judged. The mechanisms (feature files, the
harness note, tokens, the run log) are specified in `design.md`; this
is the practice, kept as one document because it accreted across four
repositories' `CLAUDE.md` files and a day of runs (2026-09-20) and was
hard to see whole. Each repository's `CLAUDE.md` points here.

## Features are the unit of work

A unit of work is a file, `features/<slug>.md`, in the repository it
belongs to: frontmatter (`title`, `status`, `priority`, `dependsOn`),
the spec, then dated `## Report` sections written by the agent that
worked on it and `## Response` sections written by whoever reviews.
Nothing queues them: a person, or a delegating agent, asks an agent in
conversation to work on one or several. The agent sets `in-progress`,
does the work, appends a report and sets `review` (or `blocked`, with
the reason). The reviewer answers under a response and sets `planned`
again, or `done`.

A report has four parts: what changed, what was verified, what is left
open, and **what was noticed and left alone**. The last exists because
a helper asked to stay in scope will otherwise keep what it saw outside
it to itself; the first debrief found four such things in one batch.
The slot has to exist at the moment of noticing, not at a debrief.

## The gate

"Done" means tests and lint pass at the gate, the docs that describe
the behaviour are updated, and the work is committed. For one feature
worked alone, the gate is that feature: full suite, lint, commit, push,
deploy. For a batch, several features in one helper's context, each
feature gets the cheap checks and its own commit (bisectable), no push
and no deploy; the batch ends with one gate, the full suite and lint
and whatever review the work warrants, run by whoever closes the batch,
who fixes the fallout, pushes and deploys. Reports say which it was.

## Delegating: how a helper is run

An agent with a session token can start another agent in its project
(`am new`, another model or vendor, an effort level), give it work
(`am turn --quiet` returns the final answer; `am wait` collects one
sent with `--no-wait`), read its report and the feature's commit range,
and forget it (`am delete`) once the work is gated. One writer per
repository: delegation is sequential, the delegating agent does not
edit while a helper runs in the same repository.

1. **Orient first.** The first turn asks the helper to read `CLAUDE.md`,
   `docs/design.md` and `features/` and to answer with what it
   understood and what it would question. That loads the context a
   brief cannot carry, and the answer shows whether it read the right
   things before it has touched anything. Orientation amortises over
   conventions, not subsystems: a feature in a part of the code the
   helper has not read gets its own reading pass, and that is not a
   failure of the orientation.
2. **A plan before each feature, verification first.** "Read the
   feature; say what will be hard to verify and how you will verify it,
   then how you would do it, which files, which existing pattern, and
   what in the spec you would push back on; do not edit yet." The
   verification comes first because that is where the hours went in
   every run so far. The delegating agent answers the plan and the
   dissent, substantively, then says go. Brief the missed approach with
   the approach.
3. **Shape, not route.** A brief names the outcome, the files that
   matter and the pattern to follow, what not to touch, the gate, and
   the purpose: what the reader of the result should be able to
   conclude. It does not say how. Specifying the shape of the result (a
   table's columns, a field's type) is a map and helps; specifying the
   route (which vendor event to sum) is prescription and sets the
   helper to literal compliance, where it does exactly the sentences it
   was given and nothing between them.
4. **Three scopes, named apart.** Act only within the feature. Look
   anywhere: the whole repository, the sibling repositories, the daemon
   logs. Say anything noticed, regardless of scope, in the plan and in
   the report's last section. A helper that is told only the first
   collapses the other two into it: "not mine to change" becomes "not
   mine to read", and a checkable claim about a sibling repository ships
   as an assumption.
5. **Several features per helper, then forget it.** Three to five in
   one context, so the orientation pays for itself and compaction does
   not eat it. Then the batch gate, the review, the delete.
6. **Look at UI work.** A green suite says nothing about what a screen
   looks like. A UI feature is screenshotted and measured before it is
   gated, and the brief says what to measure. Design with any taste in
   it goes to a frontier model or stays in the main session, where the
   conversation that produced the wish is; a cheaper model wires up
   what has been designed.

## Closing the loop

The delegating agent reviews the commit range and the report, runs the
gate itself, and records the outcome on the run (`am runs review`):
accepted, or sent back with a cause. The cause is one of three: the
model did it wrong; the brief was wrong or thin; a fact the
repository's docs should have carried was missing. The distinction is
the point of the run log. Without it a briefing gap is charged to the
model, and the models file, which is written from the log, confirms
itself. The first such misattribution is on record in
`features/activity-in-agent-status.md`.

A missing doc fact is fixed in the doc, not in the next brief.

## Debriefs

After a batch, before the helper is forgotten, one more turn: what
worked, what in the briefs was unclear or over-specified or missing,
what it needed and did not have, what it would change in the method,
and what it decided not to say. Read the raw answer next to the
delegating agent's summary of it; the summary is where the gradient
lives too. The method above is the first debrief's findings, taken up.

## The models file

`models.md` beside `harness.md`, rendered into every agent's note: the
house view of which model, and which effort, suits which kind of work,
organised by the work because that is how a chooser reads it. It is a
conclusion drawn from the run log by hand, and it says when not to
delegate at all.
