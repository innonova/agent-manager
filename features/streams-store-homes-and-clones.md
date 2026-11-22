---
title: streams, first step: the store, homes and clones
status: review
priority: 5
dependsOn: []
---

## Purpose

Work here has been tied to what it works on: a project is a list of
repositories, an agent starts in one, features are files in one, and
one agent writes to one at a time. `docs/streams.md` is the model that
replaces that, as agreed in the conversation of 2026-11-22: a
**stream** is a unit of work with a folder of its own and a home where
it clones what it needs, so that work across repositories has a place,
two pieces of work can be in one repository at once, and starting
something small leaves a small footprint.

This is its first step: enough of the model that a stream can be
started and worked in. A good result, seen from the person's chair:
one command starts a stream; an agent started in it knows what a
stream is, finds its instructions and its features in the stream's own
folder, brings in the repositories it needs by itself, and what it
writes about the work is committed without anyone running git.

## Requirements, from the conversation

- One store repository with a folder per stream, linked into the
  stream's home. Not a repository per stream.
- Each stream has its own clones of the repositories it works on.
- Agents of one stream share its clones; separation is the stream's
  job alone.
- One manager: streams beside projects, the existing setup untouched
  and working.
- Nothing existing is moved into a stream.

## Not in this step

Changes and the run log by stream, the fresh UI, archive and revive,
streams on another machine. See the order in `docs/streams.md`.

## Report (2026-11-22)

Built and deployed, gated alone, in three repositories (the manager,
the terminal client, and one line in the UI's test backend).

### What changed

- **A stream is a project of another kind** (`projects.kind`). Agents,
  tokens, chat, the dialog record, nudges, statistics and push needed
  no change. `path` is the home; `repos` is computed: the stream's
  folder, then the clones found in the home.
- **`src/streams/`**: the layout (`streams.ts`), and the service: the
  store and the manager's commits in it, starting a stream, the
  registry of repositories with their setup command and seed files,
  and cloning in the background.
- **Features** live in the stream's folder only; the changes view
  takes the clones and not the folder.
- **The harness note** describes a stream to a stream's agent through
  three new placeholders, and a project as before. The shipped note
  uses them.
- **`am`**: `stream new`, `repos`, `repo add|seed|drop`, `use`,
  `clones`; `am projects` marks streams.
- **Docs**: `docs/design.md` has a "Streams" section for what is
  built, the routes and the three settings; `docs/streams.md` says
  which part is no longer only a plan.

### What was verified

- Unit: the layout (names, links made and mended, clones found on
  disk), the note for a stream and for a project. Manager 179 unit.
- End to end, manager (164): a stream started (folder, links, one
  commit of the manager's), listed as what it is, its name kept; an
  agent that starts in the home and is told what a stream is; a
  repository registered, seeded and cloned with its setup run; a
  failing setup and a source that cannot be cloned; features kept in
  the folder and a clone's own features left out; two streams written
  to at once and committed separately; what an agent's token may do.
- End to end, `am` (11): the commands, including `am use` from inside
  an agent's session with the stream implied.
- **A real Claude agent in a stream, on a separate instance** (Haiku).
  Without touching anything it gave the codeword from the stream's
  instruction file (reached through two links) and said its work was a
  stream and where its features go. Told only that "there is a
  registered repository this stream needs", it ran `am repos`, `am use
thing`, read the clone's own instruction file, wrote
  `stream/docs/setup.md` and a feature file through the link, and said
  unprompted that it had committed nothing because its home is not a
  repository. Seconds later the store had the manager's commit
  "probe-stream: docs/setup.md, features/tidy-the-readme.md", and the
  manager listed the feature and the clone.
- **The current UI on that stream**, looked at tab by tab (projects,
  agent, features, files, changes, notes) with the console watched: no
  errors. A stream shows as a project whose repositories are `stream`
  and its clones.
- Each vendor's CLI and the instruction files (before building; the
  table is in `docs/streams.md`).

### Decided for the person

- Clones are whatever git repositories are in the home; there is no
  list of them anywhere else.
- The manager commits the store every 30 seconds, one commit per
  stream with changes, under the name `agent-manager`.
- Starting a stream is a person's; an agent may register and clone
  repositories.
- A stream cannot be renamed.
- A stream shows in the current UI among the projects, unmarked.

### Left open

- **No stream exists on this machine yet, and the store has no
  remote.** `~/streams` is made by the first `am stream new`; the
  private remote is the person's to create and add (`git -C
~/streams/.store remote add origin …`), after which the manager
  pushes.
- **Codex and Copilot were not run in a stream.** Their loaders were
  tried on the layout beforehand; the note's sentence for Codex and
  the appended instructions for Copilot are untested with real agents.
- **Landing on a shared main was not exercised**: no stream has
  changed a repository yet.
- The store's commits do not say who caused the change.
- A clone being made when the manager restarts is lost; the
  half-made directory is removed at the next attempt.
- The changes view shows a clone's whole history, not the stream's
  part of it.

### Noticed and left alone

- The UI's "edit project" form on a stream would try to save a
  repository list, which the manager refuses with a sentence saying
  why.
- `am use` with a failing setup exits 1 though the clone is there.

## Report (2026-11-22, after a review)

A second reader (Codex, reading only, with fault injection in memory)
went over the streams, the fork and the conversation keeping. Twelve
findings, none critical. What concerned streams and the conversations,
all fixed and tested unless said:

- **A command that hung could wedge a clone or the store.** A setup
  that ignored being asked to stop, or left something holding its
  output, never came back. Commands now run in a process group, are
  stopped and then killed, and the caller is answered regardless.
- **A manager restarted during a setup found the clone "ready".** A
  note beside the clone now says its setup was begun, until it
  succeeds; `am use <repository> --again` (and a button in the new UI)
  runs it once more, never by itself.
- **A failed push of the store was not tried again** until another
  file changed. It is, at every sweep.
- **A long status was read from its last 8,000 characters**, so a
  clone with many changed files was undercounted and a sweep of the
  store could miss a stream. What is parsed is read whole.
- **An empty directory was enough to call a conversation deleted**
  where the vendor keeps them elsewhere. Only a conversation found
  under the same root counts; and only "not there" is absent, a
  directory that cannot be read is an error.
- **A hand-back owed to a new conversation could be lost** if writing
  it failed. It stays owed until it is written, and is given at a
  resume if the start never got it.
- **Deleting a project left its agents' kept conversations and
  inherited dialogs behind.** They go with the agents now.

Not fixed: a clone job that failed stays in the manager's memory after
its stream is deleted (a few bytes, until the next restart).

Manager 196 unit and 168 end-to-end.
