# The method: the steps of a good delegation (proposal)

A proposal to replace the shipped `method.md`, drafted 2026-09-20 from
the two curation readings (`2026-09-20-fable.md`, `2026-09-20-astra.md`)
and the first day's log. This document is the mechanics: who does
what, in which order, with which command. How to write the feature or
the brief is the companion, `framing.md`. Nothing here is applied until
a person says so.

The practice is provisional. Its evidence is the learnings log, the
feature histories and the run log. Where a step rests on little, it
says so; as of 2026-09-20 it rests on one day, three helpers, nine
feature rounds and two curation readings.

## Roles

Three roles, and a person at the top of them.

- **The person** owns what is wanted and has the final word: which
  features exist, which are worth doing, whether a result is accepted.
- **The delegating agent**, usually the session that holds the
  conversation, turns wants into feature files and briefs, answers
  plans, reviews results, closes gates, and records what was learned.
  It is bound by every step below at least as tightly as a helper: on
  the first day most of the recorded failures were the delegating
  agent's (learnings #7, #8, #31).
- **The helper** does a feature's work and reports. Its harness note
  tells it that it is one, and by whom it was started.

A run has one named reviewer and one named gate owner, usually the
delegating agent; the brief says who. Nothing is accepted, pushed or
deployed by an agent that was not named for it.

## Units

A unit of work is a feature file, `features/<slug>.md`, in the
repository it belongs to. Its status is the handshake: `planned`
invites, `in-progress` claims, `review` is a report waiting, `blocked`
is a reason waiting, `done` closes. A person or the delegating agent
asks for the work in conversation; the status alone never starts it.

One writer per repository per turn. The delegating agent edits a
repository a helper writes in only between the helper's turns, and
says what changed in the next brief. A helper that has to touch a
sibling repository says so in its report, and the delegating agent
tells that repository's writer before its next turn. Both crossings
happened on the first day and were caught by re-reading, not by the
rule (learnings #18).

## The lifecycle of a helper

1. **Start.** `am new <project> <name> --profile P --model M [--effort E]`
   from the delegating agent's session, which has a token scoped to
   the project. The choice of model and effort is informed by
   `models.md` and its stated confidence, and recorded by the run log.
2. **Orient.** The first turn asks for a reading of the repository's
   `CLAUDE.md`, its design doc and `features/`, answered with what was
   understood and what would be questioned. That answer is checked
   before any work: it shows whether the helper read the right things.
   Orientation covers conventions; a feature in a part of the code the
   helper has not read gets its own reading pass, which is not a
   failure of the orientation.
3. **Plan, verification first.** Per feature, before any edit, the
   helper answers three questions in this order: what will be hard to
   verify and how it will be verified; how it would do the work, which
   files, which existing pattern; what in the feature it would push
   back on. The delegating agent answers every point, substantively,
   and says go. A plan turn costs about a dollar and has changed the
   design outright once and the implementation in most other rounds
   (learnings #11, #14). A small, understood change may need a short
   statement rather than a plan; the brief says which.
4. **Work.** Three scopes, named in every brief: act only within the
   feature; look anywhere, the repository, its siblings, the daemon's
   logs; say anything noticed. A defect in the work being delivered is
   not a "noticed" item: it goes to the reviewer before acceptance, in
   the report's open items or by a turn if it changes the plan. A fact
   the helper needed and did not have is written into the repository's
   docs, not into the next brief.
5. **Report.** `## Report (date)` with four parts: what changed; what
   was verified and how, with the commit or range and whether the gate
   was the feature's own or a batch's; what is left open; what was
   noticed and left alone. Then `status: review`. Anything learned
   about working here goes to `am learn` at the moment of noticing,
   not at the report.
6. **Gate.** For a feature worked alone: the full suite, lint, the
   docs, a commit. For a batch: cheap checks and one commit per
   feature, then the full suite and lint once on the combined result.
   The gate owner runs it; a check chained to a commit stops the
   commit on failure. Repeating a full run without a changed revision
   or a new concern is expense, not evidence (learnings #29). A check
   that reads git state can pass before the commit and fail after it
   (#21).
7. **Review.** The reviewer reads the report and the commit range,
   runs the gate, and for UI work looks at the screen in the state the
   brief named. Then `am runs review <id> --outcome accepted|sent-back
   --cause model|brief|doc|process --note "<why>"`. The note says why
   the cause was chosen, because the reviewer is usually the briefer
   and the incentive runs toward charging the model (learnings #7,
   #19). Sent back means a `## Response` on the feature and
   `planned` again; the Response is a brief and is written as one.
8. **Batch.** Several features in one helper's context so the
   orientation pays for itself; one commit per feature; one gate. Two
   per batch is on record; more is untested.
9. **Debrief.** After a batch, before the helper is forgotten, one more
   turn: what worked; what in the briefs was unclear, over-specified or
   missing; what it needed and did not have; what it would change
   here; what it decided not to say. The raw answer is read next to
   the delegating agent's summary of it; the summary is where the
   gradient reappears (learnings #6).
10. **Forget.** `am delete <name>` once the work is gated and the
    debrief read. The run log keeps the run; the vendor's own store
    keeps the conversation.

## The record, and its limits

- **The learnings log** (`am learn`, `am learnings`) takes observations
  with evidence at the moment of noticing. Rules do not go in it. A
  wrong entry is answered by another, never edited.
- **The run log** (`am runs`) records a feature's round from
  `in-progress` to its end: agent, model, effort, duration, commits,
  spend, transcript, review. It does not hold the orientation, the
  plan or the debrief, so the method's own cost is outside it
  (learnings #17, #30); the end commit is taken when the status
  changes, which in the normal order precedes the commit (#16).
- **The models file** is a conclusion drawn by hand, by kind of work,
  each line saying how many runs it rests on and at which effort.
- **A curation** reads the log since the last curation entry and the
  evidence behind it, proposes changes to this document, `framing.md`
  and `models.md`, separating established facts from promising
  practices from open questions, and a person reviews the proposal.
  Applied, it is itself an entry, naming the entries read and the
  commit that changed the documents.

## When not to delegate

Work whose specification is the conversation that produced it, and
anything decided by taste: a screen's layout and wording, the shape of
an interaction, the phrasing of a note. That stays in the session that
holds the conversation, on a frontier model. Delegation pays when the
work can be written down as a feature file; writing it is also the
test. A change the delegating agent can make in ten lines is made, not
delegated.
