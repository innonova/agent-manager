# Framing work: how to write a feature and a brief (proposal)

The companion to the method. The method is the steps; this is what is
said at each of them. Drafted 2026-09-20 from the two curation readings
and the first day's log; the evidence stands beside each rule, because
this is the document the log argues with. Nothing here is applied until
a person says so.

## One rule under all of it

Say the purpose. What should the reader of the result be able to see,
do or conclude? Every failed brief on the first day was a mechanism
without its purpose: "sum the output tokens from message_delta" without
"so that the count moves while the model thinks"; "reserve the height
while a turn runs" without "the reader must not lose their place". The
helper implemented the sentence and the sentence was wrong (learnings
#4, #5, #19, #25).

## Three kinds of sentence, kept apart

A feature or a brief contains three kinds of statement, and the helper
has to know which is which:

- **Requirements**: what must be true of the result. The shape of it, a
  field's type, a table's columns, a screen's behaviour in a named
  state. These are the map; the run log's column list helped, the
  measurements of the overlay helped (learnings #3).
- **Facts**: what is known and verified, with where it was found. A
  measured layout, the record types in a vendor's stream, a poller's
  behaviour. A fact that belongs to the repository goes into its docs
  as well, or instead (learnings #25).
- **Suggestions**: a route the writer has in mind, offered for the
  helper to challenge. A route stated as a requirement caps the result
  at the writer's foresight, and the writer's foresight had a hole
  each time it was tried (#4, #5, the overlay covering the newest row).

Prescription is right when the writer already holds the complete
solution, the change is mechanical, and the helper is a model that
does not fill gaps; that is a small share of work and often a sign the
writer should do it in the session instead.

## Writing a feature

A feature file is the durable form of a brief: it is read by whoever
picks the work up later, a person included, so it carries its own
context.

- **Title and first paragraph**: the purpose and the observable result,
  before any mechanism.
- **Requirements**, as above, including what the result must not do.
- **What will be hard to verify**, named, and how it should be
  verified. This is where the hours go (learnings #17, #28); saying it
  in the feature lets the plan turn start from it.
- **Facts and pointers**: where the relevant code, docs and patterns
  are; which sibling repositories the work touches and who owns those
  parts.
- **The gate**: worked alone or as part of a batch, and who owns
  acceptance.
- **History**: the Reports and Responses that follow are the feature's
  memory. A Response is a brief for the next round and follows every
  rule here; the two costliest rounds on record were Responses that
  named a route (#4, #5). Name the latest agreed scope when a Response
  changes the original.
- **Not in the file**: the model or effort it should run on (that is
  the delegating agent's choice at the time), and anything that only
  the current conversation explains. If the feature cannot be written
  without that, it is not ready to delegate.

## Writing a brief

A brief is the turn that gives a helper a feature, or answers its plan.
It is short, because the feature carries the substance.

- **Which feature, and what to read first**: the file, its history,
  the repository's docs, and anything the delegating agent changed in
  the repository since the helper's last turn (learnings #18).
- **The purpose in one sentence**, even though the feature has it:
  the helper reads the brief last.
- **The three scopes, every time**: act within the feature; look
  anywhere; say anything. A helper told only the first collapses the
  other two into it (#6).
- **What the round is worth**: an order of magnitude of time or cost,
  so a helper past it stops and reports rather than grinds. No brief
  on the first day said this, and no helper stopped.
- **The gate and the owner**: cheap checks or the full suite, commit or
  not, who pushes and deploys. Ambiguity here produced repeated full
  runs for no new evidence (#29).
- **For UI work, the state to look at**: which transcript length,
  which activity, which viewport, and what to measure. A helper's own
  screenshot proved what it showed and not what mattered because the
  brief did not say (#23).
- **Answers to a plan** are substantive or they stop coming: each point
  gets a yes, a no with the reason, or a decision recorded where the
  next agent will read it (the design doc, not the report).

## What not to write

- Imperatives about how to work ("never", "always", "do not"), when
  the fact behind them would do. The harness note learned this first
  (#13); briefs have the same failure.
- A route through the code or the vendor's protocol as a requirement.
- Praise or blame of the helper's model. It reads the brief, and the
  cause of a failure is recorded on the review, with the reason, not in
  the next brief.
- A relayed note from the person, verbatim. Turn it into purpose,
  requirements and facts first; the relayed version got the four
  sentences it contained and nothing between them (#3).

## Reading the answers

- A report's "noticed, left alone" part is read as carefully as its
  first part; it is where the next round's first item has come from
  every time so far.
- A plan's pushback is answered on its merits. A helper that is told
  "as specified" once stops pushing back.
- The summary the delegating agent writes of a helper's answer is not
  the answer. The raw text is kept beside it, and read (#6).
