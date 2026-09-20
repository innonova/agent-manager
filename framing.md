# Framing work: features, briefs and orientation

The companion to the method: the method is the steps, this is what is
said at each of them. Written for a colleague who did not sit in the
conversation, which is the one thing an agent started here lacks. The
evidence stands beside each rule because this is the document the log
argues with.

## The rule under all of it

Say the purpose. What should the reader of the result see, do or
conclude? Every failed brief on the first day was a mechanism without
its purpose: "sum the output tokens" without "so the count moves while
it thinks"; "reserve the height" without "the reader must not lose
their place". The agent did the sentence, and the sentence was wrong
(learnings #4, #5, #19, #25). An agent that knows the purpose can
correct the sentence; one that only has the sentence cannot.

## Where intent lives

An agent arriving cold gets the intent of the project from the docs
and the intent of the work from the feature. Both have to be good
enough to carry it, and the day showed where they were not.

- **The project's purpose** is the design doc's first sections and,
  once written, the person's own statement of what this system is for
  and what a good result looks like. That statement is the first thing
  a new agent reads. It does not exist yet.
- **Facts an agent needed and did not have** go into the docs of the
  repository they belong to, at once. Two poller facts and the location
  of the daemon's logs cost rounds before they were written down
  (learnings #2, #25). A fact that stays in a brief is lost with it.
- **Decisions** go into the design doc when they are made, not into a
  report that nobody reopens.

## Three kinds of sentence

A feature or a brief says three kinds of thing, and the agent has to
know which is which:

- **Requirements**: what must be true of the result. The shape of it:
  a field's type, a table's columns, a screen's behaviour in a named
  state. These help; the run log's column list and the measured layout
  were the two best things in any brief (learnings #3).
- **Facts**: what is known and verified, and where it was found.
- **Suggestions**: a route the writer has in mind, offered to be
  challenged. A route stated as a requirement caps the result at the
  writer's foresight, which had a hole each time (#4, #5, the covered
  row). Prescribe a route only when you hold the whole solution and
  want it typed, and then consider typing it yourself.

## Writing a feature

The durable form of a brief, read later by people and agents who have
nothing else.

- Purpose and observable result first, before any mechanism.
- Requirements, including what the result must not do.
- What will be hard to verify, and how. Naming it here lets the plan
  start from it; the hours went there every time (#17, #28).
- Facts and pointers: the code, docs and patterns that matter, across
  every repository the outcome touches. The feature names the outcome,
  never a repository as its boundary.
- Roughly what the work is worth, so an agent past it stops and says
  so rather than grinds. No brief on the first day said this and no
  agent stopped.
- Its history: the Reports and Responses that follow are its memory. A
  Response is a brief for the next round and is written like one; the
  two costliest rounds on record were Responses that prescribed a
  route (#4, #5).
- Not in the file: the model it should run on, and anything only the
  conversation explains. If it cannot be written without that, it is
  not ready to hand over.

## Writing a brief

The turn that hands a feature over or answers a plan. Short, because
the feature carries the substance; warm, because it is to a colleague.

- Which feature, what to read first, and what changed in the
  repositories since the agent's last turn (#18).
- The purpose in one sentence, even though the feature has it.
- That the agent works under the same rule as everyone here: do what
  the work needs, fix what you find in your own work, say what you did,
  ask first for the short list. Not a scope.
- What the round is worth, and the gate: alone or in a batch, who
  pushes and deploys.
- For UI work, the state to look at and what to measure; an agent's
  own screenshot showed what it showed and not what mattered because
  nobody said (#23).
- Answers to a plan are on the merits, every point. An agent told "as
  specified" once stops pushing back.

## Orientation

The first turn, and the one that decides how much context the agent
has for everything after. It asks for a reading of the project's
purpose, the repository's `CLAUDE.md`, the design doc and `features/`,
and for an answer in two parts: what it understood, and what it would
question. The second part is read as carefully as the first; on the
first day it changed a size cap, a hub decision and an empty-file rule
before any code existed, and it is where an agent tells you what the
docs failed to carry.

## What not to write

- Imperatives about how to work, where the fact behind them would do.
  The harness note learned this first (#13).
- A route as a requirement.
- Praise or blame of a model. The cause of a failure is recorded on the
  review with its reason, not in the next brief.
- A person's notes relayed verbatim. Turned into purpose, requirements
  and facts first; relayed, they got the four sentences they contained
  and nothing between them (#3).
- "Act only within". The first draft said it, and it was the authority
  gradient written down.

## Reading what comes back

- The report's last part, what was noticed, is where the next round's
  first item has come from every time.
- The summary a delegating agent writes of an answer is not the answer.
  The raw text stays beside it and is read (#6).
- A defect an agent found in its own work and fixed on its own
  judgement is the method working, not a scope breach.
