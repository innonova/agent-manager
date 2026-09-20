# The method: working with agents

How work is given to agents under this manager and how agents give
work to other agents. Drafted 2026-09-20 from two curation readings of
the first day's log and a rethink that evening: the agents we start
are colleagues we trust, not helpers we manage. The companion,
`framing.md` (`am framing`), is how to write the feature and the
brief.

Provisional, and it says so. It rests on one day: three agents, nine
feature rounds, two readings. Where a step rests on little, it is
marked.

## The premise

An agent started here is a trusted colleague with less context. It
works under the same rule as every other agent on this manager,
including the one that started it: do what the work needs, take the
small adjacent fix and say so, and ask first for the short list (a
force push, a history rewrite, ending sessions, work that changes
what was asked for). It is not confined to a list of files or a
repository. The first version of this document confined it, and the
log shows what that cost: a defect in an agent's own shipped work
went unsaid because it was "beyond the spec", and a fix the agent had
in hand waited for permission (learnings #6, and the run log's third
round).

What such an agent lacks is not trust but context: it did not sit in
the conversation that produced the work. So the method spends its
effort on giving context, not on limiting action. The docs carry the
intent of the project; the feature carries the intent of the work; the
orientation is where an agent takes both in; the plan is where it
shows what it took in, and where it is answered.

## Units and roles

A unit of work is a feature file, `features/<slug>.md`, in the
repository it belongs to. It names an outcome, not a repository: the
agent that takes it owns every repository the outcome touches, for the
duration. Splitting one outcome by repository across two agents was the
first day's structural mistake: the agent that built the field could
not know what the screen would say with it, and said so (learnings
#5).

Its status is the handshake: `planned` invites, `in-progress` claims,
`review` is a report waiting, `blocked` is a reason waiting, `done`
closes. A person, or an agent, asks for the work in conversation; the
status alone never starts it.

Roles are about who does what, not rank. The person owns what is
wanted and the last word. The delegating agent, usually the session
that holds the conversation, writes features and briefs, answers
plans, reviews, and records what was learned. The agent that takes a
feature does the work, reports, and is heard. One repository has one
writer at a time; the writer is whoever holds the feature that touches
it, and an agent that finds it must write where another is writing
says so in the next turn rather than waiting.

## Bringing an agent in

1. **Start** it with `am new <project> <name> --profile P --model M
   [--effort E]`. Which model is a judgement informed by `models.md`
   and what the work is (see Choosing, below).
2. **Orient it in the vision, then the code.** The first turn asks it
   to read what the project is for (the design doc's purpose and
   principles, and the person's own statement of what a good result
   looks like, once that exists), then `CLAUDE.md`, the design doc and
   `features/`, and to answer with what it understood and what it
   would question. That answer is read before any work: it shows what
   the agent took in, and it is the one place a missing doc fact
   surfaces before it costs a round.
3. **Plan together, verification first.** Per feature, before any
   edit: what will be hard to verify and how; how it would do the
   work; what in the feature it would push back on. Every point is
   answered on its merits, and a decision that will matter to the next
   reader is written into the design doc, not the report. This is not
   a checkpoint; it is the two agents thinking about the same thing
   before one of them types. It has changed the design outright once
   and the implementation in most rounds, for about a dollar a time
   (learnings #11, #14).
   A plan may be skipped for a small, understood change; setting the
   feature `in-progress` may not: that transition is what opens the
   run, and a round that goes planned to review leaves no run behind
   (learnings #48).
4. **Let it work.** The agent does what the feature needs, across the
   repositories it touches, fixes what it finds in its own work, and
   records what it learns as it goes (`am learn`). It stops and says
   so when the work turns out larger than the brief valued it at, or
   when something changes what was asked for.
5. **Read its report** as its account, in four parts: what changed,
   what was verified and how, what is left open, what it noticed. The
   third part is where a known gap in the delivered work goes, and it
   is settled before acceptance.
6. **Gate together.** Done is: the tests and lint pass, the docs that
   describe the behaviour are updated, the work is committed, and for
   UI work someone has looked at the screen in the state the brief
   named. The agent runs the checks; the delegating agent runs them
   again only where it has a concern, and looks at the screen with its
   own eyes. A check chained to a commit stops the commit on failure;
   three commits shipped red or mis-described on the first day for
   want of that, all the delegating agent's (learnings #8, #31).
7. **Close the loop in writing.** `am runs review` with an outcome and
   a cause, and a note saying why: what the agent had, what it did not
   have, and which of those explains the result. The reviewer is
   usually the briefer, so the note is written against the incentive
   to charge the model (learnings #7, #19).
8. **Batch** several features in one context so the orientation pays
   for itself; one commit per feature; one gate. Two per batch is on
   record; more is untested.
9. **Debrief** before parting: what worked, what the briefs got wrong,
   what it needed and did not have, what it would change here, what it
   held back. The raw answer is read beside any summary of it
   (learnings #6).
10. **Part.** `am delete` once the work is gated and the debrief read.
    The run log keeps the run and the vendor keeps the conversation.

## Choosing the model

Every feature does not need the strongest model, and the cost
difference is large. As of the first day: Opus 5 did manager work in
half the time and well under half the cost of Sonnet 5 on the one
near-comparable pair, with better plans and honest reports; there is
no working strategy yet for Sonnet 5 on this codebase, and the
comparison is confounded by the context each was given; Fable 5.1 is
where design and taste stay. Opus 4.8 is the next experiment, for a
reason the person gave and the log should test: it reasons more like
the session that holds the conversation, whatever it lacks in
particular coding measures. `models.md` holds the current view with
how many runs each line rests on.

## The record

- The learnings log takes observations with evidence at the moment of
  noticing (`am learn`); rules go in this document after curation; a
  wrong entry is answered, not edited.
- The run log records a feature's round from `in-progress` to its end.
  It does not hold the orientation, the plan or the debrief (learnings
  #17, #30), so the method's own cost is read from transcripts.
- A curation reads the log since the last curation entry, proposes
  changes to this document, `framing.md` and `models.md`, a person
  reviews them, and the curation is itself an entry naming what it
  read and the commit that changed the documents.

## When to delegate

Delegation is an economy, not a rule. Work done in the session that
holds the conversation has the most context and the strongest model
and costs the most per token and the most of that session's attention;
work handed to another agent costs a hand-off (a feature written well
enough to carry the intent, a plan answered, a review, a gate) and
gets back a cheaper model with less context. Nothing says difficult
work belongs elsewhere; on the first day the two changes that mattered
most to the person were made in the session in ten lines each, while
their features were still being written.

Delegate when all of these hold:

- the work can be written down as a feature file that carries its
  purpose without the conversation; writing it is the test;
- the hand-off costs less than the work: a plan and a review are two
  turns of the delegating agent's attention, and a small change is
  cheaper made than briefed;
- the result can be checked without the conversation: a gate, a
  screenshot, a diff a reviewer can read;
- the cheaper model has a record on that kind of work, or the round is
  meant to build one.

Keep it in the session when any of these hold instead:

- the specification is the conversation, or the result is decided by
  taste;
- the work is hard in a way that needs everything the session knows,
  and getting it wrong is dear;
- speed matters more than cost, and the round trip is the bottleneck;
- the change is small.

Batch several features per agent so the hand-off is paid once, and
record the round so the economy can be checked against what it
delivered.
