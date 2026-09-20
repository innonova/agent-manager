---
title: a commit says which turn of which agent made it
status: review
priority: 3
dependsOn: []
---

## Purpose

The changes tab lists the project's commits with who made them and for
what. Today "who" is the run's agent when the commit falls in a feature
run's window, else the git author, and "for what" is the run's feature.
Most commits on this machine fall in no run window: the main agent's own
work is not feature-driven, and every agent commits under the same git
identity (the person's), so the list says the person made them. And
even inside a run window, nothing leads from a commit to the moment in
the transcript where it happened: the turn, the text around it, the
reason.

The point is to make a commit answer "which agent, which turn" for
every commit an agent makes here, and to make that a link into the
transcript, so a person reading the changes tab can go from a commit to
the conversation that produced it. Attribution by run window then
becomes the fallback for commits made before this existed, and the git
author the fallback for commits made outside the manager.

## Requirements

- A commit made by an agent through this manager is recorded as that
  agent's, with its turn: the agent, the session, the transcript item
  index of the commit, the time.
- The commits list (`GET /api/projects/:id/commits`) carries that on
  each commit, so a client can name the agent and link to the item.
  Attribution order: this record, then a run window, then the git
  author.
- The record survives a manager restart and rebuild of the transcript
  (transcripts rebuild from the daemon's logs; item indexes are stable
  for a session).
- The changes view's half (a row that names the agent and the turn's
  time, and goes to the transcript at that item on click) is a second
  turn, once the manager half is in; do not build it in this turn.

## Facts

- Claude reports each commit on its stream (`vcs_state_changed`, kind
  `commit`); the Claude adapter turns it into `ingest.committed` with the
  branch and cwd, and `agents.service.ts` (around line 1582) appends a
  `system` item "committed on <branch>". Codex and Copilot report no
  such event; for them the record can only come from watching HEAD, which
  is out of scope here. Say so in the report.
- The commit's hash is not on the event: `git rev-parse HEAD` in the
  event's cwd at that moment gives it (`src/changes/git.ts` has `head()`).
  An agent may commit in any of the project's repositories; the cwd says
  which.
- `src/changes/changes.service.ts` `commits()` does the attribution by
  run window today, and its comment states the tie-break rule; it reads
  git afresh on every call, nothing cached.
- `CommitInfo` in `src/changes/git.ts` has hash, subject, author, at.
- Transcript items have a `sessionId` and an `index`; the UI's `agent`
  route shows a transcript; whether it can scroll to a given item is
  for the second turn to find out.
- Runs live in the `runs` table with `base_commit` / `end_commit`; the
  read cursor and the commits list are described in `docs/design.md`
  (Changes). Behaviour changes go in that document.

## Suggestions

A small table (project, repo, hash, agent id, agent name, session id,
item index, at) written when the `committed` ingest fires, keyed on
repo and hash, is the obvious shape; `commits()` joins it before the run
window. A commit event that arrives while the manager cannot resolve
HEAD (a race with a push, a cwd outside the project) is worth logging
and dropping rather than guessing. The hub proxies this route per
project, so a spoke's table serves its own projects and nothing else
needs to change.

## Report (2026-09-20)

**What changed.** The manager half only, as the spec asked; the changes
view's half is a second turn.

- A `commit_attributions` table (`db.service.ts`): `(project_id, repo,
  hash)` primary key → `agent_id, agent_name, session_id, item_index,
  at`. New table, so no migration; `ON DELETE CASCADE` with the project.
- `agents.service.ts` records a row when `ingest.committed` fires **and
  the session is live** (`!sl.attaching`): it captures the transcript
  index the "committed" line will take, then (fire-and-forget, since the
  index is already in hand) resolves HEAD in the commit's cwd via
  `head()` and upserts the row keyed on the hash. Guarded to live events
  because on a replay `git rev-parse HEAD` gives the current HEAD, not
  the one at the commit's moment; the row is already on disk and item
  indexes are stable per session, so it survives the rebuild. A cwd that
  is not one of the project's repositories, or a HEAD that will not
  resolve (a race with a push), is logged and dropped — the suggested
  shape, followed as written.
- `changes.service.ts` `commits()` now attributes in three steps: the
  recorded turn (agent, and its `sessionId`/`item` for a later link into
  the transcript), then the run window (agent), then the git author; the
  feature slug still comes from the run window. `CommitRow` carries
  `sessionId` and `item`; the agent filter matches either source.
- Docs: the attribution prose and the commits route response in
  `docs/design.md` rewritten for the three steps and the new fields.

**What was verified, and how.** A new `test/commit-attribution.e2e-spec.ts`
on a real git repo: the fake agent announces a commit on a "commit"
turn (it makes no real one, so HEAD is the fixture commit), and the
commits list then attributes HEAD to the agent — its name, not the git
author "t" — with a `sessionId` equal to the current session and a
numeric `item`; and after a manager restart on the same data directory
(a full transcript rebuild) the row is still there and still names the
agent, confirming replay does not overwrite it. `npm run build` clean.
Full suite and lint run once at the end of the batch.

**What is left open.**
- Codex and Copilot report no commit event, so their commits get no turn
  record and fall through to the run window or the git author; recording
  theirs needs watching HEAD, which is out of scope here (stated in the
  spec's Facts).
- A commit an agent makes in a sibling repository (its cwd names one
  repo) still gets no turn record for the other repo, and a commit made
  by an agent between turns with no `committed` event is unattributed —
  both fall back to the run window or git author, as before.

**What I noticed and left alone.**
- The hash comes from HEAD at the moment the event is processed, not from
  the event (Claude does not carry it); two commits in quick succession
  could in principle record the later hash for the earlier event. Inherent
  to deriving the hash from HEAD, as the spec's Facts set out; not chased.
- The changes view (`agent-manager-ui`) is left untouched this turn, as
  instructed; its row and the transcript link are the second turn.

Gated with the batch (with `quiet-turn-returns-the-answer` in
`agent-manager-cli`): committed per feature with cheap checks, full
suite and lint once at the end.
