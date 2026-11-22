# Streams: work detached from what it works on

A proposal, written down on 2026-11-22 from the conversation of that
day. Most of it is built (the store, homes, clones, the registry, `am use`;
an agent of a stream starts in its home; forking an agent into one;
putting a stream away and bringing it back; the fresh UI): what exists
is described in `design.md`, "Streams". The rest of this document is
still the plan. It sits beside
`design.md`, which describes the manager as it is; when a part of this
is built, its description moves there.

Each statement below is one of three kinds, and says which: **decided**
(the person's word, in the conversation), **proposed** (this
document's choice, open to challenge), or **checked** (a fact, with how
it was found).

## Why

Today a project is a named list of repositories, and everything hangs
off that list: an agent starts in the first repository, features are
files in a repository, the changes view is the repositories' commits,
and one agent writes to a repository at a time. That ties the work to
what it works on, and it has cost us in four ways.

- **Work that is about several repositories has no home.** A feature
  that changes three repositories is filed in whichever one, and the
  instructions that belong to the work ("how we finish", "you may be
  running inside this system") are copied into each repository's
  `CLAUDE.md`. `mimiri-project` is a repository with no code, made by
  hand to hold exactly this.
- **Two pieces of work cannot touch one repository at once.** The
  shared checkout allows one writer.
- **A repository we do not own cannot carry our files.** Features and
  instructions in the repository assume we may commit them there.
- **A project is heavy to start and never ends.** Registering
  repositories, or making a repository for the project itself, is
  setup; small work that should be started, finished and put away has
  nowhere to live but inside something permanent.

The system has taken this step before, each time for the same reason:
notes moved out of the repository into the manager's keeping, "agents
have a host, projects do not", and "the unit is the outcome, never a
repository". This is the same step for the project itself.

## The model

**Decided.** The unit of work is detached from repositories. It has
its own folder for instructions, documentation and features, and it
checks repositories out as it needs them, each into a copy of its own,
so that two units can work on one repository at the same time. It may
live for years (the estate's) or be started, finished and put away.

**Decided: the name is "stream"**, at least while both kinds live in
one manager: "project" keeps meaning a list of repositories, and a
second word keeps conversations and code unambiguous. If in the end
there is only one kind, it can take either word.

A stream is:

- a **name and a purpose**;
- a **folder in the store**, holding what the stream knows and decides;
- a **home** on a machine, where its agents start, with the stream's
  clones beneath it;
- its **agents**, with their transcripts, chats and dialog records, as
  today.

**Decided: separation is the stream's job, and only the stream's.**
Agents of one stream share its clones, one writer per clone at a time
as now. Whoever wants two writers on one repository starts a second
stream. There is no second layer (a clone or a worktree per agent)
solving the same problem.

## On disk

**Decided.** One store repository for all streams, a folder per
stream, linked into the stream's home. Not a repository per stream:
that leaves a footprint at every start and keeps the idea that a
stream is a big permanent thing. Each stream has its own clones;
duplicated `node_modules` is an optimisation problem and must not
shape the design.

**Proposed layout:**

```
~/streams/.store/                the store: one git repository
  <stream>/
    AGENTS.md                    what this stream is for and how it works
    features/<slug>.md           its units of work, in today's format
    docs/                        whatever else it wants to keep
~/streams/<stream>/              the home: where its agents start; not a repository
  stream -> ../.store/<stream>   the stream's own folder
  AGENTS.md -> stream/AGENTS.md  where the vendors' loaders look
  CLAUDE.md -> stream/AGENTS.md
  <repository>/                  this stream's clone of each repository it uses
```

- **The manager makes the commits in the store** (proposed, and not
  disputed when first said). Many agents committing into one
  repository is the notes problem again: one agent's `git add -A`
  sweeps a neighbour's folder, and pushes race. The manager already
  watches feature files; it commits a stream's folder when its files
  change, naming the agent or person whose turn changed them when it
  knows, and pushes when the store has a remote. Agents write files
  there with their ordinary tools and never run git in it.
- **The home is a plain directory**, so nothing an agent does with git
  in a clone can touch the store, and the home's path never changes:
  Claude Code finds a conversation by working directory, and a stream
  that is archived and revived must find its conversations again.
- **Both paths are settings** (`AGENT_MANAGER_STREAMS_DIR`, the store
  beneath it unless set apart).

## Instructions, in three layers

Instructions belong to whoever they are true for:

- **the machine** (`~/.claude/CLAUDE.md` here): what exists on this box;
- **the repository** (its own `CLAUDE.md` / `AGENTS.md`): its stack,
  its commands, its gate, how it is deployed, its hard rules ("never
  restart the daemon"). True for whoever works on it, from whichever
  stream;
- **the stream** (its `AGENTS.md` in the store): what the work is for,
  how this stream finishes work, who to ask.

The middle layer exists today and the third does not, which is why its
content is smeared over the repositories.

**Checked (2026-11-22, one scratch home with a linked instruction file
and a clone beneath it, each file naming a different codeword, each
CLI asked what it knew):**

|                     | The stream's file, through the link, at the start | The repository's file, when working in the clone                  |
| ------------------- | ------------------------------------------------- | ----------------------------------------------------------------- |
| Claude Code 2.1.325 | yes                                               | yes, from the first file it reads there                           |
| Codex 0.162.1       | yes                                               | no: only when started inside the clone, and then not the stream's |
| Copilot CLI 1.0.83  | no through a link; yes as a real file             | yes, from the first file it reads there                           |

So the layout works as it stands for Claude. **Proposed for the other
two:** the harness note of a stream's agent says that each clone has
its own instruction file, to be read before working there (Codex needs
that said); and for Copilot the manager hands the stream's file over
through the channel it already uses for the harness note, since a link
is not followed.

## Repositories

**Proposed: repositories become a registry of their own**, kept by the
manager, independent of any stream. An entry says:

- where to clone it from;
- **how a fresh clone becomes a working one**: a setup command (`npm
ci`), and the untracked files it needs (`.env` and the like), kept
  by the manager in a seed directory and copied in. A clone is not a
  working checkout until both have happened, and neither comes from
  git. Seed files are on this disk only, never in the store.

A stream takes a repository with one command (`am use <repository>`,
proposed): clone into the home, set up, record that this stream uses
it. An agent may do that on its own initiative when the work needs it.
The registry also answers "who else is in this repository": the
streams that use it.

**Decided: nobody owns main.** A stream works on branches while its
work is unstable and merges to main on its own recognizance: rebase,
run the repository's gate on the result, push; if someone else got
there first, again. The rule every agent here already works under
(finish, commit, push, deploy without asking; judgement, not
approval).

**Proposed, following from that:**

- Branches carry the stream's name (`<stream>/<topic>`), so a
  repository's branch list says whose is whose.
- **Deploys come from main after landing**, never from a branch: two
  streams deploying one after the other then both install what main
  holds.
- **What there is one of per machine is the repository's to guard**,
  in its own scripts, with a lock: the UI suite's fixed ports, the
  installed services. Clones multiply working trees, not machines. A
  repository's instruction file says what it guards.

**Decided: features may leave, the obligation to document does not.**
Whoever changes a repository's behaviour updates its design document
and README in the same landing, as now. **Proposed:** a commit made
for a feature carries a trailer naming it (`Feature:
<stream>/<slug>`), so the repository's history still says why, to
anyone with the store.

## Features, changes, the run log

**Proposed.** A feature is a file in the stream's folder, in today's
format, read and written exactly as now; the manager's poller looks
there. A feature that changes three repositories is one file in one
place. The run log records a commit range per clone the work touched.
The changes view becomes "what this stream's agents committed, in its
clones", which the manager can already attribute, instead of "every
commit in these repositories".

## Archive and revive

Built 2026-11-22 (`design.md`, "A stream put away"; `am stream
archive`, `am stream revive`). What follows is the plan it was built
from; where the build differs, `design.md` says how: an agent is
compacted only while its context is still cached, and uncommitted
files go on the person's word rather than being asked about one by
one.

**Decided.** A stream can be put away and brought back, to fix a bug
say. Archiving keeps the stream's folder, its agents and their
context, and removes the clones, which are the bulk and can be made
again.

**Proposed, as agreed in outline:**

- **Before the clones go**: unpushed commits and branches are pushed,
  or the archive is refused; untracked files in the clones are listed
  and asked about.
- **Each agent is compacted at archive, with the dialog handed back.**
  The prompt cache is warm then; a revival months later would pay for
  the whole context at full price, most of it reads of files that have
  since changed.
- **Each clone's commit is recorded.** At revival the manager clones
  again, sets up, and tells each agent how long it was away and what
  landed since.
- **The agent's conversation survives.** Built 2026-11-22: the manager
  keeps its own link to each conversation file, and an agent whose
  record is gone starts a new conversation with its dialog handed back
  (`features/conversations-the-vendor-deletes.md`).

Compression of what an archive keeps (session logs, conversation
files) belongs here too, in the manager; not built, not urgent.

## The manager and the UI

**Proposed, and not disputed: one manager, with streams beside
projects.** About a fifth of the manager is built on "a project is a
list of repositories" (projects, features, changes, files, the run
log: some 4,300 of 21,000 lines). The rest holds and talks to agents
and does not care: the adapters, the agent lifecycle, chat, the dialog
record, nudges, statistics, push, accounts, hosts. A second manager
would duplicate that four fifths, and an agent could not move between
the two without an export. In one manager there stays one login, one
`am`, one public address, one set of spokes.

- New modules for what is new: the store, homes and clones, the
  registry, features from the store, changes by stream. The modules
  of the old kind are not edited.
- The seam is small: where an agent starts, which directories it
  sees, what its harness note says, where its features are.
- The cost: deploying stream work restarts the manager the live
  agents run under, as every deploy does today.

**Decided: a fresh UI**, taking what we learned, with the current one
left running. **Proposed:** in its own repository, served by the same
manager beside the old one. What it starts from:

- the flow and the chat as two records, each with its own input, from
  the first screen;
- the phone designed in, not added at breakpoints;
- every screen looked at before it is called done, and tests that
  measure geometry;
- the transcript rendering copied across unchanged: it holds the
  hard-won vendor detail.

What it is organised around is not decided, and will not be decided in
words: it is design work for the session that holds this conversation,
done by building something to look at.

## Not now

- **Decided: nothing moves.** No existing project or agent is moved
  into a stream until we are happy with the setup. How an agent would
  move (its working directory changes, and Claude Code finds a
  conversation by directory) is a bridge for then.
- Agents of a stream on another machine: a home there, with its own
  clones and a way to reach the store.
- Sharing clones' dependencies to save disk.

## Open

Answered by the person on 2026-11-22: the name is "stream"; one store
will do, with a private remote, and a stream whose folder must be kept
apart is a problem for the day it arises; the first stream is the
fresh UI.

Still to be said by the person:

- whether an agent may start a stream. Today only a person can.

Found by running (2026-11-22):

- **Agents land on a shared main without being walked through it.**
  Two streams, each with a clone of one scratch repository and a Haiku
  agent, each told one sentence at the same moment ("add X to the
  library and get it onto main; track it as a feature first"). Both
  read the stream's and the clone's instructions, wrote the feature in
  the stream's folder first, branched as `<stream>/<topic>`, ran the
  repository's gate, committed with the `Feature:` trailer and pushed.
  The second found main had moved, rebased, kept both changes in the
  order the file asks for, ran the gate on the result and pushed; both
  were on main 39 seconds after being asked, the gate green on what
  landed, each feature at `review` with a report, and the store had
  one commit per change per stream. The harness note carried all of
  it. One agent invented a git identity for its commit; the note now
  says whose identity commits carry.
- **An agent can be forked into a stream with its context.** Built
  the same day (`design.md`, "Forking an agent"; `am fork`): a new
  agent, in the stream, that begins with the whole conversation of the
  agent it was forked from, is told that it is a copy and where it now
  is, and has that agent's dialog with the person as its own. The
  original carries on untouched. So a stream need not start from
  nothing: its first agent can be the conversation that gave rise to
  it. It is also the way an existing agent can be moved into a stream
  when the time comes: forked there, and the original archived.

Still to be found by running:

- how much friction a fresh clone's setup really is, repository by
  repository;
- Codex and Copilot agents in a stream;
- what the UI wants to be.

## Order

1. The store, homes and clones in the manager, with the registry and
   `am use`; a stream's agents start in its home.
2. Features from the store; the store's commits.
3. The fresh UI, as the first stream, built on 1 and 2.
4. Changes by stream, the run log per clone. (Built: `design.md`,
   "What a stream changed".)
5. Archive and revive, once a stream has finished. (Built ahead of 4.)
