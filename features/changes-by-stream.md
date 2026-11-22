---
title: what a stream changed, and a run's commits per clone
status: review
priority: 6
dependsOn: []
---

## Purpose

A stream's clones are whole repositories, so the changes view of a
stream shows every commit those repositories ever had: other streams'
work, other people's, years of it. The question the view exists for is
"what did this stream do", and today it cannot answer it. The run log
has the same gap from the other side: a stream's feature lives in its
folder, so a run records a commit range in the store, and says nothing
of the clones where the work was done.

From `docs/streams.md` (2026-11-22, proposed and not disputed): "The
run log records a commit range per clone the work touched. The changes
view becomes 'what this stream's agents committed, in its clones',
which the manager can already attribute, instead of 'every commit in
these repositories'."

A good result, seen from the person's chair: opening changes on a
stream shows the stream's own commits, landed or not, each with the
feature it was made for; the repository's whole history is one click
away, not the default. A run of a stream's feature says which commits
it made, in which clone.

## Requirements

- **A stream's commit list is the stream's commits by default**: what
  its agents committed, what carries the stream's `Feature:` trailer
  (which survives the rebase that lands it), and what is on its
  branches and not yet on main. Everything else in the clone is there
  on request.
- **A commit's feature, for a stream, is read from its trailer** first:
  `Feature: <stream>/<slug>`. The run window stays the fallback, as for
  a project.
- **The unread count** counts what the default list shows.
- **A run of a stream's feature records, per clone, where it stood when
  the run began and when it ended.**
- **A project of the older kind is unchanged.**

## Suggestions, open to challenge

- Commits on branches other than the one checked out are part of a
  stream's list: its work may sit on several.
- The clones a run touched are kept beside the run (`run_clones`), not
  in the run's own row, whose `base_commit` and `end_commit` keep
  meaning the feature's own repository.

## Hard to verify, and how

- That a landed, rebased commit is still shown as the stream's: an
  end-to-end test that rebases onto a moved main and looks again.
- That another stream's commits on the same repository are not shown:
  two streams with clones of one remote.

## Not in this round

- The store's commits naming who caused them.
- A changes view across streams ("who touched this repository").

## Report (2026-11-22)

Built in the manager, with the new UI and `am runs` following; gated
alone.

### What changed

- **A stream's commit list is its own commits.** A commit counts as
  the stream's when it is on one of the clone's branches and not on
  main, or one of the stream's agents made it in a turn, or its
  message names a feature of the stream (`Feature: <stream>/<slug>`).
  The repository's whole history is `?scope=repository`; in the new UI
  the switch reads "this agent's / the stream's / the repository's".
- **It survives landing.** A stream lands by rebasing, which gives a
  commit a new hash. The trailer travels with the message; and the
  manager now also remembers, for a commit a turn made, when the work
  was first committed and its subject, which a rebase keeps. So a
  landed commit is still shown as the stream's, still names its agent,
  and still links to the moment in the flow.
- **A commit's feature comes from its trailer** for a stream, with the
  run's window in that clone as the fallback.
- **Unread is by time** for a stream: made after you last marked the
  clone as read.
- **A commit made from the stream's home is attributed.** An agent of
  a stream works from a directory that is no repository, so the
  vendor's "committed" came from nowhere the manager knew; the commit
  is now found in whichever clone got one in the last two minutes.
- **A run of a stream's feature records each clone's range**
  (`run.clones`), and `am runs` prints it (`lib a1b2c3d..e4f5a6b`).
- A project of the older kind is unchanged, by test.

### Verified

A new end-to-end file with two streams on one repository: a fresh
clone lists nothing of the stream's; work on a stream's branch shows
with its feature; the other stream sees none of it; after both land
by rebasing, each still sees its own and not the other's, and the
agent's commit keeps its link to the turn; a run records the clone's
range; a project lists all five commits as before. The new UI has a
browser test for the three-way switch. Manager 199 unit and 176
end-to-end; CLI 22 and 11; new UI 30 unit and 12 in the browser.

### Left open

- **Not tried with a real agent**: whether Claude's "committed" notice
  names the clone or the home in practice (both are handled, the
  second by the two-minute rule).
- **A commit with no trailer, not made in a turn the manager saw, and
  already landed** is the repository's, not the stream's: a person
  committing by hand in a clone and landing it, say.
- **The two-minute rule can misattribute** when two clones of one
  stream both get a commit within two minutes and one agent reports
  one of them: both are recorded for that agent's turn.
- **The current UI** has no switch for the repository's history; it
  shows a stream's own commits.
- The scan looks at the newest 2,000 commits of a clone for the
  stream's own; a stream's landed commit older than that in a busy
  repository drops off its list.

### Noticed and left alone

- The changes "since I last looked" diff of the current UI
  (`/api/projects/:id/changes`) still measures a clone from a commit,
  not by stream.

## Report (2026-11-22, two things after the first)

- **The store's commits now say who may have caused a change**, which
  was this feature's one "not in this round". The manager still does
  not know which turn wrote a file, so it says what it does know, in
  the commit's body: who wrote into the stream's folder through the
  manager since its last commit ("Written through the manager by
  aek."), and which of the stream's agents had a turn since then
  ("worker had a turn in the stream since its last commit."). A file
  edited by hand with nobody at work has no body. The subject stays
  `<stream>: <files>`.
- **A run of a stream's feature could be seen without its clones** for
  an instant after it opened: the run was written before git had been
  asked where each clone stood. Found by this feature's own test
  failing once under load. The clones are asked first and written with
  the run.

Manager 199 unit and 176 end-to-end.

## Report (2026-11-22, what a real agent showed)

I ran the one check the first report left open, a real Claude agent
(Haiku) committing in a stream's clone on a separate instance, and it
found two things no test of mine had:

- **The feature was not read from the commit.** Agents write
  `Feature: x`, a blank line, then `Co-Authored-By:`. Git's own
  trailer parser counts only the last paragraph, so it saw the
  co-author and no feature. The manager now reads every `Feature:`
  line of the message itself.
- **The agent was not named, because Claude never said it had
  committed.** Its "committed" notice is about the repository a
  session starts in, and a stream's agent starts in its home, which is
  none. So for a stream that channel says nothing, ever, and the
  two-minute rule I built on it never fires for Claude. The manager
  now reads it off the agent's own commands: a hash git printed after
  a commit, and (the real agent committed with `-q`, which prints
  nothing) the commits that appeared in the clones while a command
  that ran git to commit was under way.

After both: the real agent's commit shows with its feature, its agent,
and a link to the command that made it. About 10 cents in three runs.

Tests: a unit test for reading `Feature:` lines, and end-to-end cases
for a printed hash, a quiet commit, and a commit that appears while
the agent runs something else (not its own). Manager 201 unit and 177
end-to-end.

Left open: the window rule takes a commit another agent makes in the
same clone, in the same seconds as this agent's commit command, for
this agent's.
