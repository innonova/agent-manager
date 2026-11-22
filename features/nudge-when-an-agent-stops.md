---
title: ask an agent that stopped whether it can go on
status: in-progress
priority: 5
dependsOn: []
---

## Purpose

The person runs agents that should keep going for as long as there is
meaningful work left, and they do not: they stop at "natural stopping
points", a milestone reached and reported, with plenty still to do and
nobody there to say "go on". The harness note asks them to keep going,
the chat gives them a way to report without stopping, and they stop
anyway: ending a turn at a milestone is deeply trained.

So the manager asks. When an agent for which this is turned on stops,
the manager reads its last message, and if the agent neither needs the
person nor says the work is done, it asks the agent, after a few
minutes and in the manager's own name, whether it can go on or wants
the person paged. A question, not an order: the agent is the one who
knows.

A good result, seen from the person's chair: an agent given a day's
work is still at it in the evening, or has paged them with what it
needs, and never sits idle for hours at a milestone. And an agent
that really has nothing more it can do is asked once and then left
alone.

## How it works, as decided in the conversation (2026-11-21 and 22)

These are requirements; the reasoning stands beside each.

- **Per agent, off unless turned on.** It suits an agent with a long
  job, not one in a conversation.
- **A model reads the agent's last message first**, and says one of
  three things, with a line of why:
  - _it needs the person_ (a question, a decision, a look, access):
    the person is paged by push notification, as a chat question does,
    and the agent is not nudged. Worth having by itself: today an
    agent that stops with its question in its last message, and not in
    the chat, reaches nobody.
  - _the work is done_: nothing happens.
  - _it paused with work left_ (or it is not clear): the nudge.
  Its mistakes are cheap both ways because the nudge is a question: a
  blocker it missed gets a nudge and the agent answers "page them"; a
  blocker it imagined pages the person, which is no worse than today.
- **The nudge is a question with three answers**: carry on, have the
  person paged, or the work is done. It says it comes from the
  manager and that nobody is watching. Never an instruction to
  continue: that would invite make-work, and pressure on an agent
  that cannot do more.
- **Not again within thirty minutes of work.** The person's words:
  "the key objective is to prevent a model that really isn't able to
  do more to keep being pressured". An agent is nudged again only when
  it has worked at least thirty minutes since the last nudge; one that
  answered a nudge in a minute is left alone until a person writes.
  The first stop after a person's message can always be nudged,
  however short the work was: a task given, twelve minutes of work
  and a stop with plenty left is the case this exists for.
- **A few minutes pass before the nudge, and the wait is visible.**
  The flow's input is covered by a notice that says the manager is
  about to ask the agent whether it can go on, and when. To type
  there the person presses a button on the notice, which calls the
  nudge off: no race between their message and the manager's, and no
  doubt about what will happen. A message from a person by any other
  way (the chat, `am`) calls it off too.
- **Never**: after the person stopped the turn or took a message
  back; after a turn that ended in an error or a usage limit; while a
  background job runs (the existing poke is for that); when the
  account's usage window is nearly spent; for more than twenty nudges
  in a row without a word from a person.

## The screen

- The agent's edit form has the setting, in words that say what it
  does ("when it stops, ask it whether it can go on").
- While the manager reads the last message or waits to nudge, the
  flow's input carries the notice with its one button.
- The flow has a line for what the manager made of each stop ("stopped
  with work left: … ; asking it at 14:32", "needs you: … ; you were
  paged", "says the work is done: …"), and the nudge itself is a
  message from the manager.

## Must not

- Order the agent to continue, or imply that stopping was wrong.
- Nudge an agent the person stopped.
- Leave the person unable to type: the notice's button is always
  there, and pressing it is all it takes.
- Spend a model call on an agent that has this turned off.

## Facts and pointers

- The manager already sends turns of its own (the background poke,
  `MANAGER_AUTHOR`), runs a model as a child process (the dialog's
  classifier, `DialogService.runClassifier`), and pushes to phones
  (`PushService`, used by chat questions).
- The statistics (`src/stats/`) already tell turns the manager started
  from the others, and what "work since" a moment is.
- Considered and not taken: Claude Code's `Stop` hook can refuse a stop
  and feed the agent a reason to go on within the same turn. It is
  Claude only, cannot wait for the person, and reads as an order.

## Suggestions, open to challenge

- The wait: five minutes.
- Which model reads the last message: to be tried on real last
  messages from the transcripts before choosing; a small one may do,
  since the judgement is about one message.

## Hard to verify, and how

- That the question does make an agent with work left carry on, and
  leaves alone one without: a real Claude agent in a separate
  instance, given a task in parts, with the wait set short.
- That the reading of last messages is right: tried against real ones
  with the verdict of the strongest model as the reference.

## Not in the first round

- Agents on another machine, if anything about them differs.
- A report of how nudges went (taken up, declined) beyond what the
  flow and the statistics show.
