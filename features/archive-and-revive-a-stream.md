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

## Report (2026-11-22, after the review)

A read-only review by Codex of the first version found fifteen things,
most of them real, before any stream had been put away with it. All
are fixed and deployed; the first version was live for about twenty
minutes, on a machine with no stream on it.

### What the first version got wrong

- **A question git did not answer was read as "nothing to save".** A
  failed `git status` gave zero uncommitted files. It now refuses,
  saying what could not be told.
- **Only branches were looked at.** A tag, a note or any other ref the
  remote does not have, linked worktrees, and a submodule with work of
  its own now refuse, each by name. A file hidden from `git status`
  (assume-unchanged, skip-worktree) is listed with the uncommitted
  ones.
- **Another remote's stale refs counted as "pushed".** Only `origin`,
  as just fetched, is evidence now, and a remote that cannot be asked
  refuses instead of warning.
- **Things could slip in between the look and the start**: a turn, a
  new agent, a clone, or a second request. A request now owns its
  stream from the first look to the last step, what is at work is
  asked again once nothing new can begin, and every agent the stream
  has by then is stopped, not the ones the plan listed.
- **A stop that failed was ignored.** It refuses now: something might
  still be writing in a clone.
- **A revival could begin while clones were still being removed**, and
  the removal would then delete a clone that was in use again. Refused
  now, by the same ownership.
- **A removal that failed half way put the stream back as if it were
  there.** It stays away, says what was left, and a clone is moved out
  of its place in one step before it is deleted, so there is never
  half a clone where a whole one is expected.
- **A manager stopped at the wrong moment of a revival left a stream
  away with no record to come back by.** The stream is marked as back
  before the record is removed.
- **The record was not required to be committed.** It is.
- **A branch the remote never had by name was not restored**, silently.
  It is made again at the recorded commit; if that fails too, the
  notice says so.
- **An agent's session could be restarted while its stream was away**,
  and would then miss its notice. Refused.
- **An agent's token got past "a person only" with a trailing slash in
  the address.** The scope now reads a path as the router does, and
  the two routes refuse an agent's token themselves.
- **A revival asked for twice doubled the notice.** One per absence
  now, in a column of its own.

### One thing added that the review did not ask for

Letting uncommitted files go is now tied to what was shown: the dialog
sends back a key for the list it displayed, and if anything else is
uncommitted by the time the request arrives, it is refused and shown
again. `am stream archive --discard` still means "whatever is there",
since nothing was shown.

### Decided, and worth knowing

- **Commits no ref holds are not counted as work**: what a rebase, an
  amend or a reset leaves behind for the reflog. Every rebase leaves
  some, so counting them would refuse nearly every stream. They go
  with the clone.
- **These refuse rather than being handled**: tags and notes that are
  not on the remote, worktrees, submodules with their own work. Each
  needs a decision in the clone (push, delete, remove) that the
  manager does not make. If that turns out to refuse too often in
  practice, pushing tags is the first to automate.
- **A remote that is down means the stream cannot be put away** until
  it is back.

### Verified

New tests for each of the above that can be provoked from outside: a
unit file for the look at a clone (`src/streams/unsaved.spec.ts`:
deleted remote branches, a detached HEAD, stashes, notes, tags,
worktrees, a submodule's own commit, a corrupt index, no remote), and
in the end-to-end file a stale ref of another remote, a tag, an
unreachable remote, a corrupt index, a hidden file, the key for what
was shown, two requests at once, a restart while away, the address
spelled four ways, a branch restored at its commit, and a stream away
twice told once. Manager 192 unit and 172 end-to-end; CLI 22 and 11;
new UI 30 and 11.

Not provoked by a test: a stop that cannot be confirmed, a removal
that fails, a record that cannot be committed, a revival asked for
while clones are being removed. Each is a few lines read twice, not a
test.

## Report (2026-11-22, the reviewer's second look)

The reviewer read the fixes as new code. Of its fifteen findings it
called six fixed and nine partly, and found fourteen more things in
what the fixes had left or made, most of them further out than the
first round's. Fixed, except one that cannot occur here.

- **The fetch that served as evidence could itself change the clone or
  be stale.** A clone set up to prune tags lost an unpublished tag to
  the look; a clone that follows only some branches kept a stale
  memory of the others, which then counted as "pushed". The remote's
  branches are now fetched into a namespace of the manager's own, with
  its own refspec and settings; nothing of the clone's refs is touched
  or trusted, and what was fetched must agree with what the remote
  lists.
- **What is checked out was only looked at when the clone had refs.**
  A detached HEAD in a repository with no branch left went unseen.
- **Some questions still failed quietly**: which commit is checked
  out, which branch is main (now read from the remote itself, not
  from the clone), whether there is an origin at all.
- **A remembered remote branch can be the last thing holding
  commits.** It refuses, by name.
- **A submodule** is now looked at as strictly as the clone, in its
  own repository; the kept repository of one that is no longer
  checked out refuses.
- **An origin inside the stream's own home** is no other place.
- **A session could still start while a stream was away**: through a
  fork that was under way, or by taking back a message. The check is
  now in the one place every session starts from, and putting a
  stream away refuses if any agent still has a session after the
  stops.
- **When one agent's stop failed, the others' compactions went on**
  after the stream had been given back. All are waited for.
- **Two ways to leave a stream stuck** until the manager restarted (an
  exception between marking and starting the work), and one to leave
  it away with no record (an exception after it was back). Closed.
- **The key for "what you were shown" named files and counted
  stashes.** More work in a listed file, or a different stash, kept
  the same key. It is now made of the files' sizes and times and the
  stashes' commits. And `discard: true` means whatever is found, up to
  the removal, as it was meant to.
- **A clone that was on main is checked out on main again** even if
  the remote starts a clone on another branch by then.

Not done: notices written by the first version into the old column
are not moved to the new one. The first version was live for twenty
minutes on a machine with no stream; there are none.

Also closed, found by a test that failed once under load: the
manager's periodic commit of the store could come between a file being
written and the commit that names who caused it ("started by", "put
away by"), which then said only the file's name. A change and its
commit are one step now.

Tests: the unit file for the look at a clone has nine cases (added: a
clone that prunes tags and follows one branch, a detached HEAD with no
refs, a remembered branch holding the only copy, an origin inside the
home, a submodule no longer checked out, the key changing with a
file's contents and with which stash it is). End to end: more work in
a listed file refuses under the old key. Manager 196 unit and 172
end-to-end.

I am asking the reviewer for one more, narrow, look at this round's
changes and will stop there unless it finds something that loses work
in ordinary use: each round has gone further from what an agent's
clone looks like in practice.

## Report (2026-11-22, the reviewer's third look, and where the loop stops)

Of the second round's thirteen fixes the reviewer called seven fixed
and six partly, and found six things, three of which it marked as
contrived (a person would have to set them up by hand). All six are
fixed:

- **The look could still move the clone's memory of a remote branch**
  while fetching (git updates it on the side unless told not to), and
  with it erase the one ref that should have made it refuse. It is
  told not to (`--refmap=`). Tested with a branch force-pushed on the
  remote.
- **A branch deleted on the remote between the fetch and the listing**
  still counted. What was fetched and what is listed must now be the
  same set, both ways.
- **Work staged into the index alone** (the file on disk untouched)
  did not change the key for "what you were shown". It does now.
- Contrived: an origin given as a `file:` address inside the stream's
  home; a submodule's kept repository more than six directories deep;
  a database error at the exact moment a revival is rolled back.

I stop the loop here. Three rounds: fifteen findings, fourteen, six,
each round further from a clone as an agent leaves it, and the last
round's ordinary cases needed a concurrent change on the remote or a
hand-edited index. What remains untested by anything but reading is
listed in the first review's report above. Manager 199 unit and 172
end-to-end.
