---
title: a chat with the agent, beside its work
status: done
priority: 5
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

## Report (2026-11-15)

Built in all three parts, gated alone, deployed (manager, UI, CLI), and
tried with a real model, which changed the harness note once.

### What changed

**agent-manager** (913b5a6, 900df14, and this commit for the note).
A chat table per agent and `src/chat/`: `GET/POST /api/agents/:id/chat`,
`POST …/chat/read` (the agent's own token), `POST …/chat/:id/close`,
`GET /api/projects/:id/chat` (a list of `{agentId, unread, questions,
last}`), and the event `chat.changed`, which carries the changed
messages. A person's message to an idle agent starts a turn; to an
agent in a turn it waits unread and the agent is told only that it
exists: a Claude agent on this machine by a line beside its next tool
result (the clock hook), any other by one line the manager steers in.
What is unread when the turn ends is handed over as the next turn, one
message as written, several under one heading. A turn sent the old way
(`/turn`, `am turn`) is recorded in the chat too, so the chat is the
whole of what people said. The agent's last message of a turn is not
copied. A question, and anything marked important, goes to the phones
(web push). Archiving an agent closes its open questions. The design
doc has a section "Chat: a conversation neither side stops for".

**agent-manager-cli** (4079a7d). `am chat` (the agent reading: prints
what is unread and marks it read; `--last N` reads back), `am say`
(`--decision`, `--question`, `--important`, `--re ID`, text from stdin),
`am chat close <id>`; with `--to <agent>` or an agent named they are a
person's side of another agent's chat.

**agent-manager-ui** (b7e37b5). The agent view is two panes, the flow
left and the chat with the composer right; the divider drags and is
remembered; "hide flow" folds the flow to one line of activity; under
48rem of room the panes are tabs, the chat first. Open questions are
pinned at the top of the chat with "answer" and "dismiss", counted on
the agent in the sidebar ("1 ?", beside its state badge), on a folded
project, in the header, on the chat's tab and in the attention badge,
and notified on an open page that is not looked at. A person's message
says "sent as a turn", "steered", "not read yet" or "read 14:02"; its
time links to its place in the flow. While an agent works, "send"
leaves an aside and "steer" is its own button. Its design doc has "The
chat beside the flow".

**The harness note** now has three paragraphs on the chat: what an
aside is, the three kinds of `am say`, and that a question does not
end the turn.

### What was verified

- Gates: manager unit 130, e2e 150 (9 on the chat), lint; CLI unit and
  e2e; UI type-check, unit 22 (9 on the chat store), Playwright 33 (5
  on the chat, 3 older ones rewritten for the new composer), lint,
  build.
- The races at a turn's end, with the fake agent: an aside with no
  further tool call is handed over when the turn ends, as one turn;
  several as one; a message the state change missed is delivered by
  the sweep. Not done: an actual restart of the manager with a message
  unread. The sweep is what would deliver it, and that is tested; the
  restart itself is not.
- The split at awkward sizes: a 14-column table, a long address and a
  long line of code in a chat message, at 1600, 1280, 1120, 1000, 900
  and 640 px wide, the flow folded, and a phone: no page overflow, the
  table scrolls inside itself. I looked at the screenshots, which found
  two things the assertions had not: a table's cells folding a letter
  wide, and a permission request invisible with the flow folded. Both
  fixed and now asserted.
- **A real model** (Opus 4.8, two scratch agents, archived as
  `chat-probe` and `chat-probe-2` with their chats, $2.30 together):
  - A choice left open in the brief became a `--decision` in the chat
    a minute in, before any code, and the work went on.
  - An aside written mid-turn: the hook told it, it read the message
    at its next natural point together with running its tests, the
    chat showed "read", and it took it as an observation ("already how
    I built it"), not as an order.
  - A fact it needed and could not choose: **with the first note it
    did not ask in the chat.** It carried on with the rest, and put
    the question in its last message with a placeholder in the file.
    So the question came when the work was over, in the flow, pinned
    nowhere. I added one paragraph start to the note: ask at the
    moment you find you need something, not in the last message. A
    fresh agent on the same task then asked within a minute ("I'll do
    all the rest meanwhile and slot it in"), was answered eight
    seconds later, noticed the answer through the hook, read it and
    wrote it into the file, in one turn of 113 s.
  - A session started before the chat existed (mine) got the notice
    beside a tool result once the manager was deployed.

  This is one model, three turns. It is the part to keep watching.

### Left open

- **Tuning, as expected.** What a model puts in the chat and when
  rests on the note's wording, tried on one model. Not tried: Fable,
  Opus 5, Codex and Copilot (which get the manager's steer in place of
  the hook, so an aside may read more like an order there); a long
  turn with many asides; whether decisions are over- or under-reported
  in real work; whether `--important` is used with restraint.
- **A turn that ends on a question** in its last message is still only
  in the flow. With the tuned note it should be rarer; if it stays
  common, the manager could not fix it without reading the agent's
  prose, so it is the note's job.
- **Agents running now have the old note** until their next restart;
  the notice reaches them anyway, and tells them `am chat`.
- The list under "Not in the first round" stands: images in an aside,
  the hook on another machine (spokes on an older manager also answer
  404 to the sidebar's question count, which the UI takes as none),
  `undo` and the chat record, permission requests in the chat pane.
- Known limits in the UI: an open question older than the newest 200
  messages of its chat is counted but pinned only once earlier
  messages are loaded; the two-pane layout starts at 48rem of view
  with the flow at least 18rem, both guesses to tune by use; showing a
  message's place unfolds the flow and leaves it unfolded; a page with
  web push and desktop notifications both on may show a question
  twice, as it already does for a finished turn.

### Noticed and left alone

- 913b5a6 also carries prettier's reformatting of four files that had
  nothing to do with the chat (`src/changes/*`, two commit specs): I
  staged everything after `npm run format`. Formatting only, already
  pushed; not rewritten.
- `am turn` does not read its text from stdin, `am say` does. A brief
  piped to `am turn` fails with "a text is required", and behind a
  pipe the failure is easy to miss; it cost me one false start.
- `am say --to claude` from an agent of this project was refused as
  ambiguous ("names an agent in several projects"), although the
  token is scoped to one project. `agent-system/claude` works. The
  resolver is the one every command uses, so the same holds for
  `am turn`.
- `eslint --fix` (the Playwright plugin's web-first-assertion rule)
  rewrote a correct `const two = await pane.isVisible()` into code
  that asserted something else and still type-checked. Caught because
  the lint left two warnings behind; `npm run lint` here always fixes.
- The Playwright run prints Monaco "model disposed" errors from the
  dev server during the files-view test, which passes. Older than
  this feature.
- `scripts/smoke-agents.mjs:115` has had a lint warning (a body on a
  GET) since September.

## Report (2026-11-15)

A second round the same day, on what was said after an hour of use:
the chat felt enforced, and talking to an idle agent felt disconnected,
written under the chat on the right and answered in the flow on the
left. UI only (agent-manager-ui 2f6dc24), gated alone, deployed.

- **One composer under both panes.** It belongs to the agent, not to
  the chat: outside a turn what is written is a turn in the flow, in a
  turn it is an aside in the chat, and the placeholder says which.
- **The chat can be put away.** "hide flow" in the header became a
  switch, flow / both / chat, remembered. "flow" is the view there was
  before the chat. What the chat holds meanwhile is counted on the
  switch: open questions, what the agent said since the chat was last
  in sight, asides it has not read. The header's open-question chip
  brings the chat back. On a phone the flow's tab is in front for
  someone who put the chat away.
- The "is typing" line moved above the composer, which removes the
  limit noted above (out of sight with the flow's tab in front).

Verified: a new Playwright test for the composer's extent, the flow
alone, its memory and the three counts; the suite at 34, unit 22,
type-check, lint, build; both layouts looked at in screenshots.

Open, as a matter of taste: side by side, the composer is centred
under the whole view, so it lines up with neither pane. The other
shape is the composer under the flow only, with the chat a side panel
of full height; I chose the one that does not move what is written
further from either pane. A turn sent while idle is still listed in
the chat ("sent as a turn") as well as in the flow.


## Report (2026-11-15)

A third round, on the answer to the second: one composer under both
panes was no better, and there was no reason for there to be only one.
It was an assumption carried over from the single-pane view (and from
the idea that everything said to the agent goes through the chat, the
manager deciding how it travels), not a constraint. Gated alone;
manager and UI (agent-manager-ui 9187353) deployed.

- **An input under each pane**, and what is written goes to the pane
  above it. Under the flow it is the direct conversation as it was
  before the chat: a turn, and a steer while the agent works (the
  button reads "steer"). Under the chat it is said beside the work: an
  aside while the agent is in a turn, and what wakes it when it is
  not. The chat's input takes the answer to a pinned question; there is
  no steer on it. A draft each. Interrupt is on the flow's input, and
  on the chat's where the flow's is out of sight.
- **The chat holds what was said in it.** The turn route no longer
  copies a turn or a steer into the chat (`ChatService.record` is
  gone): with an input of its own, the direct conversation listed in
  the chat as well was the clutter the chat was split off to avoid.
  This is the one choice in this round made for the person rather than
  by them; putting the copy back is ten lines. What was copied before
  today stays in the chats that have it. The harness note's sentence
  about reading the chat back after a compaction now says "what is
  said there", since a turn's text is no longer in it.
- A defect found by the tests once chats started empty: what the agent
  said while the chat was put away was not counted if the chat had
  nothing in it before.

Verified: manager build, unit, e2e, lint; UI type-check, unit 22,
Playwright 34 (the chat spec rewritten for two inputs, three older
tests back to what they asserted before the chat), lint, build;
screenshots of both side by side, at the narrowest two-pane width and
of the chat alone.

Open: on a phone the chat's tab is still in front unless the chat was
put away on a desk, which is a kind of enforcing; remembering the tab
last used would be the other way. Side by side in a narrow window the
flow's input wraps its button under the field and the chat's input
row is as tall, since the two share a row. Not looked at by a person
yet.

## Report (2026-11-15)

A fourth round, off the feature's own subject but out of the same
conversation: "withdraw doesn't actually appear to do anything when you
click it", and the use it is for, "whoops i wrote some nonsense: stop,
edit, go", not "those last two hours were a mistake, rewind". Gated
alone; manager, UI and `am` deployed.

What was wrong. On a clean, idle Claude agent withdraw did work (tried
against a real one, on an instance of its own). But it was a faint link
under the message that was disabled while the agent worked, which is
exactly when a slip is noticed, with the reason only in a hover; it
refused whenever any file in the project's repositories had changed
since the message, which counted every other agent's work in the same
tree and so refused nearly always here, in a toast at the far corner;
it could never find a message that had been steered into a turn (Claude
records those in another shape); and when it did work, the message
simply folded away and nothing came back to edit.

- **Take back = stop, and the text back in the input.** The last
  message carries an "edit" button in its header line. One click: the
  manager stops the turn if one runs, the text returns to the flow's
  input (ahead of a draft that was there, images attached again, caret
  at the end), and the agent is idle for the corrected message. While
  the agent works, and on every profile.
- **Work is not undone, and nothing is refused for it.** The line left
  in the flow says what the reply did that stays ("Bash ×3, a commit").
  The `git status` check is gone.
- **Claude forgets; the others are only stopped.** For Claude the
  conversation is cut before the message, as before, now also for a
  steer (cut where Claude read it, so the turn before it is kept, or
  nothing to cut when it had not been read). Codex and Copilot keep
  their conversation out of reach: the turn stops, the text comes back,
  and the line says the agent still has the message.
- **Asked first only when it costs something.** A message sent in the
  last two minutes is taken back at once. An older one asks, and says
  how old it is, since by then the reply may be worth keeping.
- **One line in the flow per take-back.** The stop and the session's
  end and resume fold under the "withdrawn: …" marker with the rest.
- **Names.** The button on the input that ends the turn and keeps the
  agent was "interrupt" and is "stop"; the one in the header that ends
  the agent's process was "stop" and is "end session". Labels only: the
  API and `am interrupt` / `am stop` keep their names, and `am help`
  now says what each does.
- **A stopped turn is not an error.** Found on the way: Claude ends an
  interrupted turn with an error result, so pressing the button put the
  agent in the error state under a red toast reading "[ede_diagnostic]
  result_type=user…". The adapter now reads the end of a turn it asked
  to stop as the turn's end, idle.
- `am undo <agent>` does the same from a terminal and prints the text.

Verified against a real Claude (Claude Code 2.1.299, Haiku, a daemon
and manager of their own), asking the agent afterwards what it had been
told: a message answered; a message whose command was running (the
command killed, 0.1 s); the first message of a conversation; a steer
taken back before it was read, and one after; and the whole of it
through the built UI, with screenshots (idle 0.8 s, working 0.5 s from
click to text in the input). Manager build, unit 133, e2e 150, lint; UI
type-check, unit 22, Playwright 35 (a new case with the fake agent:
linger, edit, text back, send again), lint, build; `am` unit 21, e2e 10.

Decided for the person, each cheap to turn back: no confirm for a
message under two minutes old; "edit" available while the agent works;
the two renames; unread chat asides are delivered once the stopped
agent is idle (they were going to be at the turn's end anyway).

Open: a steer taken back before Claude read it takes about 1.5 s,
since Claude starts on it the moment the turn stops and has to be
ended; in the flow the fold for a taken-back steer starts at the steer,
though the agent keeps the part of the turn before it; a message the
manager still holds for a Copilot turn is not in the transcript, so
"edit" there takes the one before it; what a take-back means for the
chat record of a turn started from the chat is as open as before.
Codex and Copilot were not tried for real, only the fake agent stands
in for "stopped, still has the message".
