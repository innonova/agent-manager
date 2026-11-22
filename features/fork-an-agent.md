---
title: fork an agent, with its conversation, into a stream or project
status: review
priority: 5
dependsOn: []
---

## Purpose

Work grows out of conversations. A stream gives such work a place of
its own, but its agents started knowing nothing, so starting one meant
writing the whole conversation down for a stranger first. The person's
words: "building the new UI in a new stream means delegating that
whole side of the project to a new context and that is not easy at
all."

A fork removes the hand-over: a new agent, in the stream, that begins
with the conversation that gave rise to it. A good result, seen from
the person's chair: one action on an agent, and a second agent exists
elsewhere that knows everything the first knew at that moment, knows
it is a copy and where it now is, and has what was agreed with the
person on record as its own; the first carries on as if nothing
happened. Said by the person when asked: "maybe we could use that to
move you over at some point so we can start eating our own dogfood".

## Requirements

- The original is untouched and carries on.
- The fork is told what it is; nothing in its context says so
  otherwise.
- What the person and the original said to each other is the fork's
  dialog record too.
- Works into another project or stream, and within the same one.

## Not in this round

- Agents on another machine, and vendors other than Claude.
- The original's chat, statistics and flow in the fork.
- Moving an agent (fork, then archive the original) as one action.

## Report (2026-11-22)

Built and deployed, gated alone, in three repositories (the manager,
the terminal client, the new UI).

### What changed

- **Manager.** `AgentsService.fork`: the checks, the copy of the
  conversation file to where the fork works, the new agent's record
  (`fork_of`, `fork_conversation`, `fork_copy`, `fork_notice`), its
  first start as a fork (`--resume <id> --fork-session` through the
  adapter's `fork` flag), and the switch to its own conversation once
  the vendor names one. `DialogService.inherit`: the original's
  exchanges and weights copied, the fork's own numbered after them.
  The notice, delivered through the session-start hook
  (`on: 'resume'`). `POST /api/agents/:id/fork`.
- **`am fork <agent> <name> [--into <project or stream>]`.**
- **New UI**: "fork…" in the agent's menu, with a name and where the
  fork works; the screen goes to the fork.

### What was verified

- Unit: the Claude adapter's arguments for a fork.
- End to end, manager (166): refused before there is a conversation
  and during a turn; forked into a stream (record, working directory,
  the file copied, the session started as a fork, a conversation of
  its own, the copy removed, the original untouched, both flows saying
  what happened); the notice once and only for the fork; the dialog
  record inherited and continued, and not polluted by what the
  original says afterwards; a fork within the same project; an agent's
  token refused across projects.
- End to end, `am` (11) and the new UI (8): the refusal with its
  reason, and in the UI a fork made from the menu, landing on it.
- **A real Claude agent on a separate instance** (Haiku). Told a
  codeword, a colour rule and a shipping day, then forked into a new
  stream. The fork had a conversation id of its own and worked in the
  stream's home. Asked without tools who and where it was, it said: it
  is "third", a fork in the stream "offshoot"; the conversation above
  was with "elder" of "origin" as it stood at the minute of the fork;
  it works in the stream's home, which is not a repository; and it
  gave the stream's purpose from the stream's instruction file and
  quoted the notice's first sentence. The original still knew the
  codeword and knew of no copy.
- **What the first real attempt found**: the notice did not arrive.
  Claude Code reports the start of a forked session as source `fork`,
  not `resume`, so the hook did not run. Measured with a hook that
  records its input (startup, resume, fork, fork), then registered for
  both; the second attempt is the one quoted above.

### Decided for the person

- A fork takes the original's profile, model, effort and permissions,
  and not its "ask it to go on" setting.
- An agent may fork within its own project; into another project or a
  stream is a person's.
- The notice says nothing is asked of the fork; it starts no turn.

### Left open

- **Cost of the first turn.** A fork's first request reads the whole
  copied context with no cache, as any resumed conversation does after
  an hour: for an agent with a full 1M window that is the price of one
  full uncached read. Not measured on a large agent.
- **The system prompt.** Claude Code keeps a conversation's system
  prompt until it is compacted, and whether a fork keeps the
  original's was not looked at separately: the fork in the check knew
  where it was, from the notice and the stream's instruction file.
  The first compaction settles it either way.
- Forking an agent whose transcript the manager has only in part (a
  very long one being paged) was not tried.

### Noticed and left alone

- The first fork of the real check, made before the hook was
  registered for `fork`, would have got its notice at its next
  restart; that path (`resume`) is in the tests and was not watched
  for real.

## Report (2026-11-22, after a review)

A second reader (Codex, reading only, with fault injection in memory)
went over the fork, the streams and the conversation keeping. Twelve
findings, none critical; what concerned the fork, all fixed and
tested:

- **Two forks into one place deleted each other's copy.** The first to
  get a conversation of its own removed the file the second still
  started from. The copy now goes only when no fork needs it, and is
  replaced whole, never written in place. Tested with two forks made
  at the same moment, the second restarted before its first turn.
- **The fork was not one moment of the original.** It did not hold the
  original's lock, so a turn or a take-back could come between the
  check and the copy, and the dialog was copied after the fork's
  session had started. It is now made under the lock, the dialog
  first, and a failure leaves nothing of the fork.
- **Forking an archived agent after a manager restart copied no
  dialog**, with the weights of the missing exchanges landing on the
  fork's own. The transcript is brought in first; the same fault made
  a recall or a hand-back of such an agent come back empty, which is
  fixed with it.
- **A share that could not be read became "no share" for good**, and
  the fork's exchanges were numbered from one. That an agent has a
  share is now in the database; one that cannot be read is said to be
  that, and is read again next time.
- **The notice could be lost on its way to the hook** and never given
  again. It is given at every start until the fork has ended a turn.
- **The tests could pass over a fork that never found its copy**: the
  fake agent resumed anything. It now keeps its conversations on disk
  when a test asks it to, refuses one that is not there, and names a
  new one at its first turn, as Claude Code does. With that the test
  failed three times on the way to passing, each time for a reason
  worth knowing.

Manager 184 unit and 167 end-to-end.
