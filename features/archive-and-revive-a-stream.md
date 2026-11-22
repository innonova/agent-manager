---
title: put a stream away and bring it back
status: review
priority: 5
dependsOn: []
---

## Purpose

A stream is meant to be something one starts, finishes and moves on
from, and its clones are the bulk of what it leaves on the disk. The
person's words (2026-11-22): "what we really want is to have a
mechanism that keeps the agent's context, and the project folder but
clears out the repo clones to reclaim the bulk of the space but the
agent and project could be brought back from an archived state to say
fix a bug".

A good result, seen from the person's chair: one action puts a
finished stream away, and nothing of its work can be lost by it; it is
out of the tree and its clones are off the disk. Months later one
action brings it back: its clones are there again, its agents answer,
and each knows how long it was away and what happened to the
repositories meanwhile.

## Requirements, from the conversation

- **Kept**: the stream's folder in the store, its agents with their
  transcripts, chats and dialog records, and their conversations (the
  manager holds its own link to each: `conversations-the-vendor-
deletes`).
- **Removed**: the clones.
- **Archiving must not lose work.** Commits that are nowhere but in a
  clone are pushed first, or the archive is refused. Files not
  committed are listed, and go only on a person's word.
- **Each agent is compacted at archive, with the dialog handed back.**
  The prompt cache is warm then; a revival months later would pay for
  the whole context at full price, most of it reads of files that have
  since changed.
- **Each clone's commit is recorded.** At revival the manager clones
  again, sets up, and tells each agent how long it was away and what
  landed since.

## Suggestions, open to challenge

- What a stream had cloned, and at which commits, is written into its
  folder in the store (`archived.json`), so it travels with the store
  and is readable without the manager.
- Archived streams are out of the list everything shows by default,
  and listed on request.
- Putting a stream away and bringing it back are a person's to do, not
  an agent's.

## Hard to verify, and how

- That a revived agent really has its context and knows what changed:
  a real Claude agent on a separate instance, a scratch repository
  that moves on while the stream is away.
- That nothing is lost: the refusals, each with what it names, in the
  end-to-end tests; and the clone directories gone only after them.

## Not in this round

- Compressing what an archived stream keeps (session logs,
  conversation files).
- A stream on another machine.
- Putting a single clone away while the stream stays.

## Report (2026-11-22)

Built in the manager, `am` and the new UI; gated alone, and tried with
a real agent.

### What it does

- **Putting a stream away** (`am stream archive <name>`, or "put
  away…" behind a stream's "⋯" in the new UI) keeps its folder, its
  home, its agents and everything the manager holds of them, and takes
  its clones off the disk. It is out of the tree and out of `am
projects` afterwards; `am projects --archived` and a line under the
  tree ("2 put away") list what is away.
- **Nothing that exists only in a clone goes with it.** Each clone's
  remote is asked first. A branch with commits no remote has is pushed
  under its own name. Commits on main that are not landed, commits on
  a detached HEAD, and a clone with commits and no remote refuse the
  whole thing, each named with what would change it. Files that are
  not committed (and stashes) are listed, and go only with `--discard`
  or the dialog's "let these go". An agent in a turn refuses it too.
- **It says first what it will do**: `am stream archive <name> --plan`,
  and the dialog in the UI, which shows the plan before its button
  works.
- **Bringing it back** (`am stream revive <name>`, "bring back" under
  the tree) clones each repository again as the registry now describes
  it, on the branch it was on, with seed files and setup; and each
  agent is told at its next start how long it was away and, per clone,
  where it stood, where it is, and what landed on main between.
- **The record** is `archived.json` in the stream's folder while it is
  away, committed in the store ("put away by aek"), removed when it is
  back ("brought back by aek").

### Where I departed from the spec, and why

- **An agent is compacted only while its context is still cached**
  (active within 50 minutes, context over 50k tokens), not always. The
  spec's reason for compacting was that the cache is warm at archive.
  For an agent that has been idle it is not: compacting then reads the
  whole context at full price, which is exactly what the first turn
  after a revival costs, and a revival may never come. The plan says
  for each agent which it will be and why. An agent you want compacted
  regardless can be compacted with its own button before the stream is
  put away. Say if you would rather it always compacts.
- **The agents are stopped, not archived.** The stream's state keeps
  turns from them. That way the ones you had archived yourself stay
  archived when the stream comes back, and the rest are as they were.
- **Uncommitted files are let go with one word for all of them**, not
  asked about one by one.

### What I verified

- **A real Claude agent (Haiku) on a separate instance.** In a stream,
  it cloned a scratch library, added a function on `triples/triple`,
  committed and did not land it, and was told a codeword and a naming
  preference. Putting the stream away pushed its branch, compacted it
  (36k to 8k tokens, 8 s) and removed the clone. Main then moved by
  two commits, one renaming the function its test calls and one adding
  a naming rule. Brought back and asked, before running anything, what
  it knew: it gave the codeword, its branch and commit, that the
  branch had been pushed and was not landed, the two commits by their
  subjects, and on its own that its branch needed a rebase, that the
  rename would break its test, and that the new naming rule might
  conflict with the preference I had stated. I had deleted the vendor's
  own memory of that directory first, so the answer came from its
  context, the handed-back dialog and the notice. About 3 cents.
- **Tests.** Manager: a new end-to-end file (the refusals, each with
  what it names; the clone gone only after them; the record; the
  branches on the remote; turns, new agents and clones refused while
  away; an agent's token refused; the revival's clone, seed, setup and
  notice; an agent without hooks told with its first message) and a
  unit test for a manager restarted on the way. 187 unit, 172
  end-to-end. CLI: 22 unit, 11 end-to-end, with the commands in its
  stream test. New UI: 30 unit, 11 in the browser, one of them putting
  a stream away through the dialog and bringing it back. The current
  UI's suite passes unchanged.
- **Looked at** the dialog and the list under the tree at desktop, a
  low screen and a phone, dark and light.

### Left open

- **Not seen for real**: a stream with real repositories (`npm ci`
  after a revival), a push that is rejected, a remote that cannot be
  reached, a revival months later, Codex or Copilot agents (the notice
  ahead of their first message is tested with the fake agent only).
- **A manager restarted while the clones are being removed** leaves
  the stream away with some clones still on the disk. A revival keeps
  them as they are; nothing removes them otherwise.
- **Deleting a stream that is away** works as for any stream, and
  leaves its folder and home on the disk as before.
- **The current UI** does not list a stream that is away and has no
  way to bring one back; that is the new UI's and `am`'s.

### Noticed and left alone

- Ignored files in a clone go without being listed. That is the point
  (dependencies, build output), but an agent's own ignored scratch
  file goes the same way.
- `git fetch --prune` is run in each clone to answer the plan, which
  also updates what the clones know of their remotes. Harmless, but it
  is a write to a clone from a question.
- The run-log end-to-end tests failed once under load during this
  work's first gate (a 23 s timeout) and passed alone and in two full
  reruns since.
