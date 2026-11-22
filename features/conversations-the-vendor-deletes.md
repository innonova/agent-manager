---
title: keep an agent's conversation when the vendor deletes it
status: done
priority: 5
---

## Purpose

An agent that has not been used for a month can no longer be spoken
to. Claude Code removes a conversation's record once it has gone
unused for thirty days, in a sweep that any Claude session starting on
the machine sets off, and a resume of a conversation that is gone
fails with "No conversation found". The manager's "archive keeps
everything" was not true of the one thing the vendor holds: on
2026-11-22 nothing older than 25 October was left on this machine, so
the helpers archived in September had already lost theirs, and four
real agents (trusted-updates, media-monitor, mail-server,
mimiri-project) were between six and fourteen days from it.

A good result, seen from the person's chair: an agent left exited or
archived for months answers the next message as if nothing had
happened; and one whose record is truly gone still answers, says so,
and has what was said between it and the person.

## How it works, as decided in the conversation (2026-11-22)

- **Stop the deletion.** `"cleanupPeriodDays": 3650` in the user's
  `~/.claude/settings.json`. The person's file, changed with their
  word; it has to be that file, since the sweep runs from any session.
- **The manager keeps its own hold on each conversation file**, as a
  hard link, and links it back before a resume when the vendor's copy
  is gone. No copy and no space, current for as long as the vendor
  appends to the file.
- **A fallback when the record is truly gone**: a new conversation,
  with the dialog handed back as its first act. The dialog record and
  the daemon's logs do not depend on the vendor's file.

## Must not

- Take a conversation for gone when it is only somewhere the manager
  did not look: forgetting a conversation that could have been resumed
  is the worse mistake.
- Hand the dialog back to a conversation that replaces nothing (a new
  agent, a first message taken back).

## Not in this round

- Agents on another machine: the file is on their disk.
- Codex and Copilot, whose conversations the manager cannot name.
- A summary of the work rebuilt from the daemon's log, for the new
  conversation of an agent whose record is gone.
- Compressing what is kept (see the conversation of the same day: for
  archives, in the manager; for live files, a compressing filesystem).

## Report (2026-11-22)

Built and deployed, gated alone. The setting is in
`~/.claude/settings.json` on this machine (the person's go-ahead).

### What changed

- `keepConversation` (`src/adapters/claude-conversation.ts`): the
  second name, renewed when the file was replaced, the file put back
  when the vendor's name is gone, and "gone" when neither is there.
- Adapters say which file is a conversation's (`conversationFile`):
  Claude's does; the fake one does when a test names a directory and
  plays the vendor.
- The agents service keeps the link at every turn's end, before every
  session start, and for every local agent when the manager starts.
  Before a resume: put back (the flow says so), or, with nothing left,
  a new conversation, a line in the flow, and a row in `dialog_owed`.
  A deleted agent's link goes with it.
- The hand-back has a third occasion, `on: 'start'`: the hook of a
  conversation that begins (`SessionStart`, source `startup`) asks,
  and is answered only when a hand-back is owed, with a notice worded
  for an agent that has not even a summary. A weighing is started
  first when the weights are stale.
- The hand-back files' heading no longer says "after a compaction",
  which was already untrue of one asked for on request.
- `docs/design.md` ("A conversation the vendor deletes") and the
  README (what an operator may set).

### What was verified

- Unit: four tests of the link (nothing there, made and current,
  renewed after a rename, put back with its directory), the notice's
  three wordings.
- End to end with the fake agent, the test playing the vendor: linked
  by a turn's end; linked again after a rename; deleted and put back,
  the same conversation; nothing left, a new conversation with the
  line in the flow, the hand-back owed once and not twice; a new agent
  owed nothing; and a vendor directory that does not exist leaves the
  resume alone.
- **A real Claude agent in a separate instance** (Haiku). Told a
  codeword and a rule. After its first turn the manager's name and
  Claude's were one file (same inode, two links). Claude's name
  deleted and the agent restarted: the file was back, the flow said
  so, and asked for the codeword it answered "Pelican". Then both
  names deleted and restarted: a new conversation, the hook fired at
  the process's start (the hand-back line was in the flow six seconds
  after the restart, before any message), and at the next message the
  agent's first act was to read the file, after which it gave the rule
  and the codeword. One confound: that agent had also written the two
  facts to Claude's own memory directory in its first conversation,
  and said its answer matched it; the file was read first all the
  same.
- That Claude Code appends in place: this session's own conversation
  file has had one inode since 12 September, through fourteen
  compactions.
- What a resume of a missing conversation does today: `claude -p
--resume <unknown id>` exits 1 with "No conversation found with
  session ID", before any request.

### Decided for the person

- "Gone" is only said where the manager has found some conversation
  under the same root since it started (this agent's or another's),
  or the directory the file would be in exists. Without that evidence
  the resume is tried as before.
- A conversation found gone is forgotten for good: the agent's record
  no longer names it.
- The link is kept under the manager's data directory, per agent, and
  an earlier conversation's link is left there when an agent gets a
  new one.

### Found at the deploy, and fixed

At its start the installed manager linked 10 of the 20 local
conversations it has on record. Of the other ten, two belong to Codex
agents, and eight Claude conversations were already deleted:

- active agents: `dns-server/claude`, `mimiri/fable`,
  `agent-system/opus48`;
- archived: `mimiri/claude`, and this project's `opus-helper`,
  `sonnet-helper`, `sonnet-ui` and `fable-curator`.

Two of the eight (`opus48`, `sonnet-ui`) showed that the first rule
for "gone" was wrong: it asked for the project's directory under
`~/.claude/projects` to exist, and Claude Code had removed
`-home-inno-projects-agent-manager-ui` along with its last
conversation. Those two would have gone on failing to resume. The
rule is now evidence of a conversation under the same root, and the
end-to-end test deletes the directory with the file.

### Left open

- **Not seen: the vendor's own sweep deleting a file the manager
  holds.** The deletion was mine, by hand. With the setting at ten
  years it should not come to that here.
- The eight agents whose conversations were already deleted will
  start new conversations with their dialog handed back the next time
  someone writes to them. None was tried: they are not mine to wake.
- Not weighed before the hand-back in the real check: the separate
  instance had the classifier off.

### Noticed and left alone

- The sweep also deletes a session's spilled-over tool results and
  subagent transcripts, which a resumed conversation may refer to by
  path. The manager does not keep those; the setting does.
- `conversationFile` replaces only `/`, `\` and `:` in the working
  directory to name Claude's project directory. Whether Claude Code
  replaces other characters too (a dot, an underscore) was not
  checked; every working directory on this machine has only letters,
  digits and hyphens. A mismatch would mean no link and, by the rule
  above, a resume left alone.
