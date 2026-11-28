---
title: ask an agent that stopped whether it can go on
status: review
priority: 5
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

## Report (2026-11-22)

Built and deployed, gated alone. Off for every agent until a person
turns it on, in the agent's edit form or with `am set <agent> --nudge`.

### What changed

- **agent-manager.** `src/nudge/`: what is read off the end of a
  transcript, the reader's instructions and the reading of its answer,
  the rule, the words of the nudge (`nudge.ts`, pure), and the service
  that listens for a turn's end, reads, pages, waits, asks
  (`nudge.service.ts`). The agent has `nudge`, the status has `nudge:
{ state, at }`, `POST /api/agents/:id/nudge/hold` calls a pending
  question off. Five `AGENT_MANAGER_NUDGE_*` settings. The model call
  shared with the dialog's classifier moved to `src/util/run-model.ts`.
  The statistics give the rule its "work since" (`StatsService.since`).
- **agent-manager-ui.** A checkbox in the edit form; `NudgeNotice`
  over the flow's input while the manager reads or waits, with the one
  button that calls it off; the input under it disabled.
- **agent-manager-cli.** `am set --nudge / --no-nudge`; the agent's
  facts say when it is on.

### Which model reads the last message

Tried on 58 real last messages (28 of this project's agent, 30 of the
xcom agent), with Fable's verdict as the reference: Sonnet 5.5 agreed
on 56, Haiku 5.5 on 53. Haiku's misses were mostly "done" read as
"paused", which only costs a question; one was a blocker it imagined,
which would page for nothing. Sonnet is the default. All 30 of the
xcom agent's stops were read as paused with work left: the agent this
feature is for.

### What was verified

- Unit: 8 tests of the pure part. Manager 169 unit and 157
  end-to-end; four new end-to-end tests with the fake agent and a
  script for a reader: off means nothing is read; the wait, the
  question, and no second question after a short answer; a person's
  message makes the next stop askable again; paging and "done"; the
  hold, a message while waiting, and a turn the person stopped.
- UI: Playwright 42. A new test turns the setting on in the form,
  sees the notice over the input (also at phone width), calls it off
  and types.
- CLI: 22 and 10.
- **A real Claude agent in a separate instance** (Haiku, the real
  Sonnet reader, the wait set to 20 s). Given a job in three parts and
  told to stop after the first, it stopped; the reader took two
  seconds ("Part 1 done; parts 2 and 3 remain…"); twenty seconds later
  the manager asked; the agent wrote parts 2 and 3 without answering
  the question first and said the job was finished; that stop was read
  as done and it was left alone. Then a job it could not finish
  without a decision: its stop was read as needing a person ("It needs
  the person to choose the logo colour…") and nothing was asked.

### Decided for the person

- The wait is five minutes, the reader Sonnet 5.5, the cap twenty in
  a row.
- "Thirty minutes since the last nudge" is thirty minutes of the
  agent's work, not of the clock: by the clock an agent that declined
  would be asked again every half hour.
- A message from a person makes the next stop askable again whatever
  came before.
- A reading that fails asks nothing.
- The notice's button reads "I'll write instead".

### Left open

- **Not seen for real: being asked a second time** after thirty
  minutes of work, and the cap. Both are in the tests with the script.
- **Push delivery was not watched.** The page goes through the call
  the chat's questions use; the separate instance had no phone
  subscribed.
- **A restart of the manager drops a waiting question.** The agent's
  next stop is read afresh; one that was waiting when the manager
  restarted stays idle until then.
- **A turn begun by anything calls the question off silently**, the
  background poke included.
- Agents on another machine were not tried.

### Noticed and left alone

- The harness note says nothing about this. An agent learns of it
  from the question itself.

## Response (2026-11-28)

aek, in the conversation: "that function we built to get the agent to
continue on long jobs are not working have a look at how the xcom agent
reacts to it". And to the xcom agent itself, three days earlier:
"clearly the manager input is not working".

## Report (2026-11-28)

It did not work, for two reasons, and both are changed and deployed.

### What the xcom agent's flow shows

Three nudges in a week (22, 23 and 25 November). After each the agent
said "carrying on", did one small item (4, 14 and 7 minutes) and
stopped again with work it named as open. The manager read that
correctly ("stopped with work left") and then did not ask again: "it
has worked 14 min since it was last asked". After the second it sat
for 37 hours until you wrote.

### Cause one: my rule was not yours

You said "30 minutes since last nudge". I built "only after thirty
more minutes of the agent's work", and told you so at the time, as a
refinement. It turned the pause into an end: an agent that stops
again after ten minutes can never reach thirty, so every nudge was the
last. It is now what you said: two nudges are at least thirty minutes
apart, and the next one is scheduled, not dropped. What ends the
asking is the agent saying it is done or needs you, you writing, or
twenty in a row.

### Cause two: the question

It asked the agent to say which of three things its stop was. The
xcom agent, asked by you, explained why that fails: the question goes
to the same judgement that just decided to stop, and "I can always
produce a plausible 'waiting for the person' or 'done'"; it proposed
showing it its own list of open items instead. That is what the nudge
does now. The model that reads the last message also lists what it
leaves open, in the agent's words, and the nudge is:

> The manager, not a person: you stopped, and nobody is watching.
> Nobody has written to you for 8 hours. A turn that ends stops the
> work until someone writes; you are asked at that point so that what
> is open and needs no person gets done while nobody is here.
>
> Your last message leaves this open, in your words:
>
> - Night maps: EW's warm fog has no effect in XCOM 2
> - Night maps: EW's rain is missing
> - Central's lines at the base: stopped and logged, but not yet seen happening in the game
> - Navigation map: walk doesn't yet go one level deeper into each screen's own lists and buttons
>
> Which of it needs the person, and for what?
>
> What needs them goes in the chat: `am say --question "<what you
need>"` reaches their phone, and you carry on with the rest
> meanwhile. What does not is yours to take up, one thing after the
> other; say what you finished with `am say` and go on to the next,
> since ending the turn to report is what stops the work.
>
> If you are at the end of what is worth doing without them, say for
> each of these why it is not. That is a fine answer, and you are not
> asked again until they write.

(That list is what the reader made of the xcom agent's real last
message of 25 November.) It is still not an order to continue, which
you had asked for; the way out is there, and costs a reason per item.

### Also

A nudge that waits now survives a restart of the manager. With up to
half an hour between two, and the manager redeployed several times a
day, it would otherwise be lost most of the time.

### Verified, and not

- The reader with its new instructions on three of the xcom agent's
  real last messages: the lists are its own open items, with one stray
  line in one of them.
- Tests: the pace, the cap, the text, a restart with a nudge waiting.
  Manager 202 unit and 178 end-to-end.
- **Not seen: whether an agent reacts better to it.** That needs the
  xcom agent's next stop, which I have not provoked. Its flow will
  show it: "the manager asks it at …" followed by what it does.

### Left open

- If the new text also buys only one item at a time, the agent is now
  asked again every half hour, so the worst case is one item per half
  hour instead of one per visit of yours. The next thing to try then
  is the vendor's stop hook, which can refuse a stop inside the turn;
  we set it aside because it reads as an order.
- A session a person ends while a nudge waits no longer cancels the
  nudge at once (the manager cannot tell it from a dropped link); it
  is simply not sent to an agent that is not idle when its time comes.
