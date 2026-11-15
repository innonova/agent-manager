---
title: a chat with the agent, beside its work
status: in-progress
priority: 5
dependsOn: []
---

## Purpose

Today a person reaches a working agent in two ways: a steer, which reads
as an order and makes it re-plan, or a turn, for which the agent has to
have stopped. And the agent reaches the person only by stopping: what it
writes between tool calls scrolls past with the tool calls, and a
question in the middle of a run is lost in the noise or ends the run.

What is wanted is a chat between the person and one agent that neither
side has to stop for. The person writes an observation the moment they
have it, instead of holding five of them until the agent pauses. The
agent reports a milestone, announces a decision or asks a question and
carries on with whatever does not depend on the answer. Turn ends become
rare: an agent runs until the work is done or nothing can proceed
without the person.

A good result, seen from the person's chair: the agent's view is split
in two, the work on the left as it is today and the chat on the right.
The right side is short and stays put. A question from the agent is
still there, pinned, an hour and four hundred tool calls later. A
decision the agent took alone stands out. What the person types there
reaches the agent within a tool call or two, without the agent dropping
what it was doing, and the person can see when it was read.

## How it works, as decided in the conversation (2026-11-15)

These are requirements; the reasoning stands beside each because the
wording around them will need tuning.

- **The chat is its own record, kept by the manager, per agent.** It is
  not a filtered view of the transcript. The transcript shows the agent
  reading and writing the chat (its tool calls); the chat holds the
  messages. Consequence, and half the point: the person's words survive
  a compaction verbatim, since they live outside the agent's context,
  and the agent can read them again afterwards.
- **A working agent is told that messages exist; it is not handed the
  text.** A line beside a tool result ("2 unread chat messages, the
  oldest 12 min old; `am chat` reads them"), at once for a new message
  and again every few minutes while something is unread. The agent
  picks the moment and fetches them, so "read at 14:32" means it
  fetched them. It is a notification and not a user message, so that it
  does not read as an order to re-plan.
- **An idle agent is woken with the text.** A chat message to an agent
  that is not in a turn starts one, carries the text along, and is
  marked read: a round trip there buys nothing. The same at the end of
  a turn: messages still unread when the agent stops are delivered as
  the next turn, so nothing written during the last seconds of a turn
  sits unread beside an idle agent.
- **Everything the person says to the agent is in the chat**, whichever
  way it travelled: an aside to a working agent, a turn to an idle one,
  a steer. The composer lives in the chat pane; while the agent works
  what is typed is an aside, a modifier makes it a steer (steering
  stays the way to interrupt), and when the agent is idle it is a turn
  as now. The person does not pick a mode in the common case.
- **The agent writes with a tool** (`am say`), and what it writes is
  one of three kinds:
  - a **message**: a milestone reached, a finding that changes the
    plan. Posted silently.
  - a **decision**: something it chose on the person's behalf. Always
    posted, always visibly a decision in the chat, and flagged
    **important** when it matters a lot (hard to undo, or the person
    would plausibly have chosen otherwise). An important one sends a
    push notification.
  - a **question**: something it wants answered while it carries on. It
    sends a push notification and stays pinned at the top of the chat
    until the person answers it, the person dismisses it, or the agent
    closes it because it no longer needs the answer. The person's
    answer is a reply to that question and reaches the agent announced
    as such.
- **The agent's final message of a turn is not copied into the chat.**
  Both panes are visible and it is the last thing on the left; copying
  it would duplicate visible text. It becomes worth doing if the flow is
  ever hidden by default.
- **The agent is told how to use it**, in the harness note, which
  reaches every vendor and the remote agents. Two behaviours are the
  goal:
  - *keep going if not blocked*: with a question outstanding, pursue
    another part of the work, or make the choice and carry on; end the
    turn only when the work is done or nothing can proceed without the
    person;
  - *decisions always show*: every choice made on the person's behalf
    is said in the chat as a decision, important when it matters.
  And the test for a message: is it worth the person's attention when
  they are not watching the flow? Narration and step-by-step progress
  stay out, and each message stands on its own for a reader who has not
  followed the work. This wording is expected to be tuned over days of
  use; the note says what is true (who reads the chat, what a push
  does) rather than commanding, as the rest of the note does.

## The screen

- The agent view splits vertically: the flow (today's transcript, all
  of it, unchanged) on the left, the chat on the right, a divider the
  person can drag, its position remembered. The flow can be collapsed
  to a one-line strip showing the current activity; final reports with
  tables need width, so the chat is a pane, not a narrow sidebar.
- A chat message that has a place in the flow (the agent's `am say`
  call, the person's turn or steer) links to it: clicking it scrolls
  the flow there.
- Each of the person's messages shows whether it has been read by the
  agent, and when.
- Open questions are pinned at the top of the chat, and the agent list
  shows "has an open question" as its own state, distinct from "waiting
  for input": the agent is still working.
- On a phone the two panes are tabs, the chat first; a push
  notification for a question lands on the chat.

## Must not

- Never lose a message: one written as the turn ends, while the manager
  restarts, or while the agent's session is being resumed is delivered,
  once.
- The notification must never slow or fail a tool call: whatever tells
  the agent about unread messages is bounded to a fraction of a second
  and silent on any error.
- Not a second steering channel: an aside must not interrupt. If
  agents turn out to drop their work on every notification, that is a
  defect in the framing to fix, not the feature working.
- Tests never touch the installed manager's data (`~/.config/agent-manager`,
  `~/.local/state/agent-manager`).

## Facts and pointers

- **The notification mechanism exists.** The clock is a Claude Code
  PostToolUse hook (`fixtures/clock-hook.mjs`) whose
  `additionalContext` lands beside a tool result without a message in
  the transcript; the manager writes `<dataDir>/claude-settings.json`
  and passes it with `--settings` at session start
  (`AgentsService.claudeSettingsFile`, `claude.adapter.ts`). It reaches
  local Claude agents only, and only sessions started after it was
  installed. A hook process inherits the session's environment, which
  has `AGENT_MANAGER_URL`, `AGENT_MANAGER_TOKEN` and
  `AGENT_MANAGER_AGENT`.
- **Where there is no hook** (Codex, Copilot, a Claude on another
  machine) the notification can travel as a one-line steer, since it
  carries no content: `AgentsService.turn(..., { steer: true })`
  delivers mid-turn where the vendor can and queues otherwise. A steer
  sent with no user id shows in the transcript as the manager's, like
  the background-job poke.
- **The agent's token identifies it.** `agent_tokens` maps a session's
  token to its agent (`AuthService.agentForToken`), so the manager
  knows a chat post came from the agent itself; `scopeAllows` is where
  a new route is let through for agent tokens.
- **Push** is `PushService.notify(null, payload)` for everyone
  subscribed; today it fires on state changes only.
- **Events** to open tabs go through `events.gateway.ts`
  (`notes.changed` is the nearest pattern).
- **The store**: the manager's SQLite (`db.service.ts`), since read
  marks and question state are queries. Removed with the agent.
- **The CLI** (`agent-manager-cli/src/commands.ts`): `am exec` already
  takes its text on stdin with a quoted heredoc, which is the way to
  give `am say` a multi-line Markdown message.
- **The UI**: `ProjectView.vue` holds the agent view, `TranscriptView.vue`
  the flow, `TurnInput.vue` the composer (text, images, steer);
  `ResizeHandle.vue` and the preferences store are what the files view
  uses for a remembered divider.
- **The harness note** is `harness.md`; the installed copy
  (`~/.config/agent-manager/harness.md`) is seeded from it and was
  identical to the shipped one on 2026-11-15. A changed note reaches an
  agent at its next restart.

## Suggestions, open to challenge

- Commands: `am chat` prints the unread messages and marks them read;
  `am chat --last N` reads back without marking (after a compaction);
  `am say <text>` posts, with `--decision`, `--important`, `--question`,
  and the text on stdin when there is no argument; `am chat close <id>`
  closes the agent's own question. A person at a terminal uses the same
  with an agent's name.
- One hook process for clock and chat rather than two per tool call.
- The hook learns about unread messages from a file the manager keeps
  per agent rather than over HTTP: nothing to time out. A remote
  agent's hook, when there is one, would have to ask over HTTP.
- Repeat the notification every five minutes while something is unread.

## Hard to verify, and how

- **Whether an agent treats an aside as an aside.** Only a real model
  shows it: start a scratch Claude agent on a task of some minutes,
  post an observation that does not change the task and one that does,
  and read what it did with each. Then the same for a question: does it
  carry on. This is the part most likely to need a second round.
- **The races around a turn's end.** A test with the fake agent: post
  while working with no further tool call, let the turn end, expect one
  turn carrying the message; post at the moment of ending; restart the
  manager with a message unread.
- **The split at awkward sizes**: narrow desktop widths, the flow
  collapsed, a long table in a chat message, a phone. Measure page
  overflow as the files view's test does.

## Not in the first round

- Images in an aside: a message with an image goes as a turn or a steer,
  as today.
- The hook for Claude agents on another machine (they get the steer).
- A project-wide room, or agents talking to each other in a chat: this
  is between people and one agent. The store does not rule it out.
- What withdrawing a message (`undo`) means for its chat record.
- Showing a permission request in the chat pane; it is the agent
  blocked on a person, so it probably belongs there too.

## Worth

About two days across the manager, the CLI and the UI. The first slice
is the store, the notification, `am chat` and `am say`, and the note;
the split screen follows on the same data. Past three days, stop and
say what is in the way.
