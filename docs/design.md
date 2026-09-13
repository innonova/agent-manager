# agent-manager design

Status: milestone one implemented 2026-09-12; kept in step with the code.

## The system

Four components, four repositories, one machine (an isolated VM):

```
agent-manager-ui  (Vue)      browser; renders what the manager tells it
agent-manager-cli (Ink)      terminal client for an SSH shell; the same API, the same accounts
      │  https (cli: loopback http), cookie session, REST + one websocket
agent-manager     (Nest)     projects, agents, users; understands the agent protocols
      │  ws://127.0.0.1:4267, no auth, loopback only
agent-daemon      (Nest)     holds the agent processes; dumb line forwarder with a disk log
      │  stdin / stdout, newline-delimited JSON
claude / codex / copilot     the agent CLIs in their headless modes
```

The daemon exists so that the manager and the UI can be rebuilt at will
while agents keep working. The manager is therefore the layer that may
churn, and everything below assumes it will be restarted often.

## Purpose

The manager makes the daemon usable: it knows what a project is, what an
agent is, what the agents are saying, and who is allowed to look. It
exposes that to the UI over an authenticated API. It is the only component
that understands Claude's stream-json, Codex's app-server protocol and
Copilot's ACP.

## Principles

1. **All agent knowledge lives here.** The daemon forwards lines; the
   manager gives them meaning. The UI never talks to the daemon and never
   parses an agent line.
2. **Rebuildable from the daemon.** Every transcript and every agent state
   is derived from daemon session logs. On start the manager lists the
   daemon's sessions, replays them and reconstructs everything. It persists
   only what the daemon cannot know: projects, agents, users, features.
3. **One normalised model.** Three vendor dialects go in, one agent state
   model and one transcript item model come out. Vendor specifics stay
   inside adapters.
4. **Trusted VM, real front door.** Agents run with permissions bypassed on
   an isolated VM. The manager is nevertheless the security boundary
   between the network and a machine that runs arbitrary commands, so it
   authenticates every request and every websocket.
5. **Single origin.** The manager serves the built UI and its API from one
   origin, so cookies and the websocket need no cross-origin handling.

## Decisions and why

| Decision | Reason |
|---|---|
| An agent may span several daemon sessions | A headless process exits (end of input, daemon restart, crash) but the conversation continues via the vendor's resume; the user thinks in agents, not processes. |
| Idle agent processes stay alive | Instant next turn, intact context; memory is cheap on the VM. An idle timeout with automatic resume is a later feature. |
| Permissions are per agent: `bypass` (default) or `ask` | Bypass is the dogfooding mode on an isolated VM. Ask keeps each vendor's own gate (Claude's prompt over stdio, Codex's approval requests with its workspace sandbox, Copilot's ACP permission requests) and routes the question to the human as a `permission` transcript item with the vendor's options; the answer goes back in the vendor's protocol. Chosen at creation, applied when a session starts. No per-agent allowlists in the manager: what is gated is the vendor's business. |
| A project is an ordered set of repositories, the first one primary | Real work spans several repos (this system is four). An agent's cwd is one repo; the others are handed to the CLI as extra directories (`--add-dir` for Claude Code and Copilot; Codex runs with full sandbox access and needs nothing). The primary repo is the default cwd and the default home of new features. |
| Agents work directly in the repository, one writing agent per repo | A single agent outpaces the human providing ideas; direct work keeps the file view live. The manager warns, but does not prevent, two agents sharing a cwd. Worktrees are a later milestone. |
| SQLite (better-sqlite3) for manager state | Small, local, transactional, no server. What it holds is tiny; transcripts are not stored, they are rebuilt. |
| Cookie session with argon2 passwords | Simplest thing that is actually secure for a small user list. The cookie carries an opaque 256-bit server-side token rather than a signed value; revocation is a row delete. |
| One turn at a time per agent; a message during a turn steers it | A second turn while one runs is refused with 409 `agent-busy`. Sent with `steer: true` instead, the message reaches the agent during the turn where the vendor can take one (Claude reads it after the running tool; Codex has `turn/steer` for the active turn) and is queued in memory for the next turn where it cannot (Copilot ends the running prompt when another arrives, so it is never given one mid-turn; Codex before its turn id is known). Queued messages are counted in the status and dropped by a stop or a manager restart. |
| Archived agents keep their history | Archival hides an agent from lists and refuses commands; its transcript is still rebuilt and readable. |
| Features are markdown files in the project repo | Versioned with the code, readable by the agent, editable by the human in any editor. |
| Changes are a diff from a base to the working tree | Git already answers "what changed since": committed, staged, unstaged and untracked in one `git diff <base>` plus `git status`. The base is a read cursor per user and repository, a feature's recorded range, or any commit; nothing is written to the tree, so an agent mid-turn is only a staleness concern. No per-hunk keep/undo: agents commit as they go, undo is a conversation or git. |
| No feature queue; the human asks the agent in conversation | An injected turn arrives without context and cannot be given a caveat or refused; the file carries spec, report and response instead, and the agent edits it itself. See Features. |
| A fake adapter and fake profile exist from day one | UI development and end-to-end tests must not cost tokens. |
| Adapters are tested against recorded daemon logs | The daemon's logs are exact transcripts; a vendor protocol change becomes a fixture diff. |
| Git diff is out of milestone one | Needs its own discussion; GitHub covers the gap meanwhile. Per-entry status in the file listing (`git status` and `git check-ignore` per directory) is cheap and is done, so the tree can tint entries as VS Code does. |
| No file containment beyond rejecting `..` (judged per path component, before normalisation; only regular files are read, at most the size cap) | Agents run with permissions bypassed and sudo on an isolated VM; containing the editor would be patching a missing barn wall with toothpicks. Authentication is the boundary. Symlinks are followed. |

## Terminology

- **Project**: one or more git repositories on this machine, each
  registered by absolute path under a short name, plus manager-side
  metadata. The first repository is the *primary* one.
- **Agent**: a named, long-lived conversation in a project: a profile
  (which CLI), a cwd, a vendor conversation id, and a history of sessions.
- **Session**: one daemon session, i.e. one process. An agent's current
  session is where its turns go; earlier sessions are history.
- **Feature**: a markdown file under `features/` in one of the project's
  repositories describing a unit of work, with frontmatter for status and
  metadata.
- **Turn**: one user message and everything the agent does until it stops.
- **Item**: one normalised transcript entry (text, thinking, tool call,
  tool result, error, system note).

## Domain model

```
User      { id, name, passwordHash, createdAt }
Project   { id, name, repos: [{ name, path }], path, defaultProfile, createdAt }   // path = repos[0].path
Agent     { id, projectId, name, profile, cwd, permissions: bypass | ask, model | null, effort | null, vendorConversationId | null,
            currentSessionId | null, createdAt, archivedAt | null }
AgentSession { agentId, daemonSessionId, startedAt, endedAt | null }
Feature   { projectId, repo, slug, title, status, priority, dependsOn[], body, mtime, range? }   // derived from files, not stored
```

Agents and their sessions are stored so the manager knows which daemon
sessions belong to which agent after a restart. Everything about what
happened inside a session is rebuilt from the daemon. An agent's `cwd` is
one of the project's repositories, given by name or absolute path and
defaulting to the primary one; it is stored absolute. When the session
starts, the project's other repositories are passed to the adapter as
`extraDirs`, so an agent working in one repo can read and edit the
others. Deleting a project stops its agents (stdin close, then SIGTERM,
then SIGKILL, bounded) and forgets them; the repositories are not
touched.

Repository names are unique within a project, match
`[A-Za-z0-9][A-Za-z0-9._-]*`, and default to the directory's basename.
Projects created before repositories existed were migrated to one
repository named after their directory.

The daemon session `label` also carries `agent-manager:<agentId>` so that a
session can be attributed even if the manager's database is lost.

## Agent state

One model for all vendors, derived by the adapter from the line stream:

| State | Meaning |
|---|---|
| `starting` | session started, vendor has not reported ready. Claude is ready as soon as it runs (it says nothing until the first turn), so its adapter starts in `idle`; the fake agent stays `starting` until its init line. A turn arriving during `starting` waits up to 5 s for readiness. |
| `idle` | ready for a turn |
| `working` | a turn is in progress |
| `waiting-input` | the agent asked the user a question and stopped (vendor-specific; e.g. ACP `end_turn` after a question is still `idle`, so this is mostly reserved) |
| `waiting-permission` | the vendor asked whether it may use a gated tool and is blocked until the human answers (agents created with `permissions: ask`); the request is a `permission` transcript item with the vendor's options |
| `error` | the vendor reported an error that ended the turn (usage limit, auth, API error); the process may still be alive |
| `exited` | no live session; resumable |

The status carries `model`, the model the vendor reports as active in
the current session (Claude's `init`, Codex's `thread/started`,
Copilot's `config_option_update`), null until it has said and after the
session exits. An agent is created with an optional `model` and
`effort`, vendor names passed verbatim at session start (Claude
`--model`/`--effort`, Copilot `--model`/`--effort`, Codex `-c model=`
and `-c model_reasoning_effort=`); the manager does not know which
values are valid, the vendor rejects a bad one at start.

The status also carries `queued`, the number of messages held for the
next turn because they arrived with `steer` while the vendor could not
take one mid-turn; the oldest is sent as a turn each time the agent
becomes idle. Each is held for the session it arrived in: a stop, an
exit or an archive drops them, a session started since never receives
them, and a manager restart forgets them (they live in memory only,
since nothing in the daemon log records them). A refusal that is only
temporary (busy again, the daemon link down) keeps the message for the
next idle.

The status also carries `background`, the number of jobs the agent has
left running (Claude Code's background shell commands and scheduled
wake-ups, announced as a list on every change). The turn ends while they
run and the agent starts a new turn by itself when they finish, so an
idle agent with jobs pending is not ready for more; the UI shows the
count on the badge and holds its "ready" notification until the
self-started turn ends. A turn the vendor starts by itself (an `init`
with no input from the manager) is `working` like any other and gets a
"resumed on its own" transcript item; the jobs' start and completion are
transcript items too. Each vendor signals this differently, verified
2026-09-12 by asking each to background `sleep 25` and end its turn:
Claude Code lists its tasks (`background_tasks_changed`) and resumes with
a new turn; Codex leaves the command item open past `turn/completed`,
completes it later and does nothing else, so the count is the open
command items at turn end; Copilot reports the call completed at once
with "started in background" in the result, sends the output as a
status-less `tool_call_update` after the turn and may go on talking
without a turn ("continued on its own" item), so the count is those
calls until their output arrives. That last one rests on the wording of
Copilot's result text; if Copilot sees real use here, rerun the probe
(ask it to background `sleep 25` and end its turn) and firm this up.

A command (turn, decision, interrupt) waits at most ten seconds for a
resync in progress and is refused with `agent-unavailable` at once while
the daemon is disconnected, so nothing queues up to run whenever the
link returns. A turn the adapter cannot build yet (a handshake not
finished) is refused the same way rather than marked working.

After a replay of a session's log (a fresh session, a reconnect or a
restart), the adapter is asked once what the process is still owed:
nothing logged means the whole handshake, a reply logged without its
follow-up means the follow-up, everything logged means nothing. Sends
produced while replaying history are dropped, since they are history
too. The same step releases decision reservations whose answer the log
does not contain, so a decision refused or lost in flight can be given
again. A turn is also refused while the adapter still has a turn open,
whatever state is displayed (a refused interrupt is not the turn ending).

Every transcript item carries `at`, the time of the daemon record it
came from, so clients can show when a turn ended, a permission was asked
or a job started. An agent idle with background jobs and no activity for
`AGENT_MANAGER_BACKGROUND_POKE_MS` (30 minutes) is poked: a short turn
asking it to check whether the jobs are still alive, since a job that
died without notifying leaves the agent waiting forever. At most one poke
per interval, none while the daemon is disconnected.

Transitions are events, broadcast to the UI and aggregated per project as
counts by state. `error` carries the vendor message verbatim (for Claude,
the `errors` array of an error result, then `result`, then the subtype).
Daemon connectivity is reported separately (`daemon` frames and the health
endpoint) and never overwrites a vendor-derived state.

## Adapters

```ts
interface AgentAdapter {
  /** state right after the process starts; default 'starting' */
  readonly initialState?: AgentState;
  /** args to add to the profile for a new conversation, or to resume one; extra repositories, permission mode, model and effort */
  startArgs(opts: { resume?: string | null; extraDirs?: string[]; permissions?: 'bypass' | 'ask'; model?: string | null; effort?: string | null }): string[];
  /** the stdin line(s) for a user turn */
  turn(text: string): unknown[];
  /** the stdin line(s) to interrupt the current turn, if the vendor supports it */
  interrupt?(): unknown[];
  /** the stdin line(s) for a message the agent sees at its next step of the turn under way; absent or empty means queue it */
  steer?(text: string): unknown[];
  /** stdin lines to send once the session is running and attached (protocol handshakes) */
  startLines?(opts: { cwd: string; resume?: string | null }): unknown[];
  /** after a full replay of the log: the handshake lines still owed, judged from what the log shows was sent and answered */
  afterReplay?(opts: { cwd: string; resume?: string | null; permissions?: 'bypass' | 'ask' }): unknown[];
  /** whether a turn is open as far as the log shows */
  turnInProgress?(): boolean;
  /** permission requests the vendor is waiting on; and the stdin line answering one with an option */
  pendingPermissions?(): PermissionRequest[];
  decide?(requestId: string, option: string): unknown[];
  /** cross-turn state at a turn end as JSON, and its inverse, for the transcript cache */
  snapshot?(): unknown;
  restore?(state: unknown): void;
  /** feed one daemon log record; returns state changes, transcript operations and lines to send in reaction */
  ingest(record: LogRecord): { state?: AgentState; error?: string; model?: string; background?: number; ops?: ItemOp[]; conversationId?: string; send?: unknown[] };
}
type ItemOp = { op: 'append'; item: Item; key?: string } | { op: 'update'; key: string; item: Item };
```

Streaming works through keys: an adapter appends a text item under a key
(for Claude, message and block index) and later updates the same key as
deltas arrive, so an interleaved stderr line or a second block never
confuses which item grows. One adapter instance exists per daemon session.

- **claude**: native stream-json. Init event gives `session_id`
  (the vendor conversation id, used for `--resume`). `assistant` events
  become text / thinking / tool_use items, `user` events with
  `tool_result` become tool results, `stream_event` deltas update the
  current text item, `result` ends the turn. Errors surface as `result`
  with `is_error`, or as `error`-typed lines.
- **copilot** (`copilot --acp`, plus `--allow-all` from the adapter in bypass mode): ACP over stdio. The adapter
  sends `initialize` on start, `session/new` (or `session/load` with the
  stored session id to resume) when the initialize reply arrives, and
  `session/prompt` per turn; `session/update` notifications become text
  (chunks grow one item until something else arrives), thinking, tool_use
  (`tool_call`) and tool_result (`tool_call_update` completed/failed); the
  prompt reply ends the turn with its usage. A `session/request_permission`
  should never arrive with `--allow-all`; if one does it is answered with
  the first allow option. Interrupt is `session/cancel`.
- **codex** (`codex app-server`): JSON-RPC over stdio. `initialize`, then
  `initialized` and `thread/start` (or `thread/resume` with the stored
  thread id) with `approvalPolicy: never` and `sandbox: danger-full-access`,
  then `turn/start` per turn; `item/*` notifications become text
  (agentMessage with deltas), thinking (reasoning), tool_use/tool_result
  (commandExecution with command, output and exit code; fileChange);
  `turn/completed` ends the turn; `error` notifications and failed turns
  become `error`. Interrupt is `turn/interrupt`.

Handshakes are driven from the log: an adapter returns `send` lines in
reaction to a record. The manager writes them only for live records,
never for records replayed after a restart or reconnect (it buffers sends
produced during an attach and drops those at or below the daemon's
boundary at attach time), so a restart never repeats a handshake or
starts a second thread. The adapters also read their own requests back
from the `in` records, so request ids stay consistent after a restart.
- **fake**: drives the daemon's fake agent fixture for tests and UI
  development; produces realistic items and state changes without tokens.

Adapters are pure: a log record in, items and state out. Tests feed them
recorded logs from real sessions (`test/fixtures/<vendor>/*.ndjson`) and
assert the items and state sequence.

Permissions in ask mode, verified 2026-09-12 by asking each CLI for a
gated action with nothing bypassed: Claude needs `--permission-prompt-tool
stdio` (without it gated tools are simply denied) and then emits a
`control_request` of subtype `can_use_tool` that we answer with a
`control_response` of behaviour allow (echoing the input) or deny; Codex
is started with `approvalPolicy: on-request` and `sandbox:
workspace-write` and sends `item/*/requestApproval` server requests whose
`availableDecisions` (accept, accept with an exec-policy amendment which
means always allow this command, cancel) we echo back as the decision;
Copilot without `--allow-all` sends `session/request_permission` with
options (allow once, allow always, deny) answered by option id. The
adapters normalise the options to allow, allow-always and deny (Codex's
own decisions are mapped one by one; a denial is never turned into an
approval), remember what is pending from the log (so a restart loses
nothing), reserve a request when an answer is built so it is answered
once, retire every pending request when the turn ends or errors, derive
`waiting-permission` from what is still pending, and mark the item
decided when our answer appears as an input record. A decision is sent
under the agent's lock on a replayed session, like a turn.

## Transcript cache

The daemon log stays the only truth; the manager keeps a cache of what
it derives from it, so that neither memory nor restart time grows with
the history of every agent ever.

- Per agent, under `<dataDir>/transcripts/`, an NDJSON file of the
  normalised items in index order (`<agentId>.ndjson`, only ever
  appended) and a header (`<agentId>.json`, rewritten atomically after
  each append): cache version, item count and byte length, a byte offset
  every 256 items, and per session the last daemon sequence its cached
  items came from, the index its cached items end at, the two boundary
  flags, the adapter's snapshot of its cross-turn state at that point
  (`snapshot()`/`restore()` on the adapter) and, for the current session,
  the agent's status then. A file longer than its header says is cut
  back on load.
- Items are cached only once settled. Everything up to and including a
  `turn_end` is settled (keys are per turn, pending permissions are
  retired at turn end), so the session's settled point moves at every
  turn end and at its "session ended" item; the write happens then, or
  once at the end of a replay. The unfinished turn lives in memory only
  and is rebuilt from the log tail after a restart.
- A live agent keeps a tail of `AGENT_MANAGER_RESIDENT_ITEMS` (500)
  items resident; older resident items that the cache holds are evicted
  after each write. `live.items` is the resident window and `itemBase`
  its first index, so an item's index is the same whether it is resident
  or read from the cache. Updates only ever target the current turn,
  which is resident.
- Restart: with a header of the current version, the tail is loaded,
  each cached session's adapter is restored from its snapshot, and the
  daemon is replayed from the cached sequence onward; the current
  session starts from the status it had at its last turn end. A missing
  or stale cache (the version bumps when an adapter's output changes)
  means one full replay for that agent, which then writes the cache. Because
  items are cached in index order, every cached session but the last
  must be there whole: a cache the daemon's log contradicts (a cached
  sequence past the log's end, a session the daemon no longer has, an
  earlier session cut short or missing from the cache while a later one
  is in it, a cached session the database does not know) is dropped and
  rebuilt the same way. A rebuild bumps a generation so writes and reads
  started against the old file stand down. A session the daemon no
  longer has is dropped at the next resync too, not only at the next
  start, so the transcript does not depend on when the process last
  started. An archived agent whose replay failed is served as it is and
  tried again once the daemon reconnects, not on every request. One
  agent's unreadable cache (or any other failure of its resync) does
  not stop the resync of the others. Archived agents are not touched at start;
  requesting one loads it, from cache and log.
- `GET /api/agents/:id/items` takes `tail=N` (the last N), `before=I&limit=N`
  (the N before index I) or the existing `from=I`, and always returns
  `total`, so clients can page backwards with stable indexes. The UI
  opens on the last 300 and fills earlier pages in when the reader
  scrolls to the top (or presses "load earlier").

The cache is a cache: deleting the directory costs a full replay of
every agent on the next start and nothing else. Nothing on disk is
trimmed; the daemon log and this cache grow with use, which is cheap
until it is not, and that day it becomes a decision of its own.

## Transcript items

A `user` item carries `by`, the name of the user who sent the turn, when
known. Turns are only sent through the manager, so it records the author
against the daemon record (session id and seq) when the input comes back
from the daemon, which is exactly the key a rebuild from the daemon has.
Turns from before this existed stay unattributed unless
`scripts/backfill-authors.mjs` is run once to assign them to one user
(right when there only ever was one). Feature responses carry the name
in their heading (`## Response (date, name)`).

```ts
type Item =
  | { kind: 'user'; text: string; by?: string }   // by: the user who sent it, when known
  | { kind: 'text'; text: string; streaming: boolean }
  | { kind: 'thinking'; text: string }
  | { kind: 'permission'; requestId: string; tool: string; title: string; input: unknown; options: { id, kind: 'allow' | 'allow-always' | 'deny', label }[]; decision: string | null }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; output: string; isError: boolean }
  | { kind: 'error'; message: string }
  | { kind: 'system'; text: string }        // daemon notices, session boundaries, resumes
  | { kind: 'turn_end'; usage?: {...}; costUsd?: number; durationMs?: number };
```

Each stored item carries its `index`, the daemon session id and the `seq`
range (`seqFrom`, `seqTo`) it was built from, so a client can always go
back to the raw lines. Synthetic boundary items (session started, resumed,
ended, history unavailable) have `seqFrom` 0.

## Features

A feature is `features/<slug>.md` in any of the project's repositories;
its `repo` is the repository it lives in and its `path` is
`<repo>/features/<slug>.md`. Slugs are unique per project: on a
duplicate the first repository wins and the manager logs the shadowed
file. A new feature is created in the primary repository unless the
request names another (the UI always uses the primary: which repository
a feature "belongs to" is rarely obvious up front, and the agent works
across the project anyway).

```markdown
---
title: Login page
status: planned          # planned | in-progress | review | blocked | done
priority: 2              # a hint for the agent; lower first
dependsOn: [db]          # a hint for the agent
---

Add a login page with a form. (The body is the spec.)

## Report (2026-09-12)

Added the page and a test. Left open: password reset.

## Response (2026-09-13)

Good. Also handle the reset; see the manager's design doc for the token.
```

Unknown frontmatter keys are preserved when the manager rewrites the
file. A missing title falls back to the first heading, then the slug; a
missing or unknown status is `planned`.

The file is the whole channel. Nothing queues or starts work: the human
asks an agent, in its ordinary conversation, to work on one or more
features, and can phrase that however the situation needs. The agent
reads the file (spec, earlier reports, the human's responses), sets
`status: in-progress`, does the work, appends a dated `## Report` with
what changed, what was verified and what is left open, and sets
`status: review` (or `blocked`, with the reason in the report). The human
reads the report in the UI, answers under a dated `## Response` and sets
the status back to `planned`, or marks it `done`. An agent asked to
work through several features re-reads the directory before finishing
and takes up anything planned that appeared meanwhile. This is spelled
out for agents in each repository's `CLAUDE.md`.

A feature's work spans a range of commits per repository: the manager
records HEAD as the base when it first sees the feature in progress
(the agent sets that; the poller notices within seconds, before any
commit of the work) and HEAD as the end when it is marked done. Later
rounds keep the first base. The range is exposed on the feature and is
one of the bases the changes view accepts (`feature:<slug>`). Marking a
feature done also moves the caller's read cursor to HEAD in every
repository of the project: done means the human has looked.

Ownership of `status`: `in-progress` is the agent's; `planned`, `review`,
`blocked` and `done` are set by either side, the human through the API.
The manager never sets a status on its own. The human can also edit
title, body, priority and dependencies through the API; the UI offers
that for planned features, before or between rounds of work.

The manager's own writes to a feature file are serialised per feature
and done as read, modify, write with a check that the file's mtime is
still what was read before the replacement is renamed into place,
retrying on the fresh content otherwise (and giving up after a few
rounds rather than clobbering), so a status change or response does not
overwrite a report the agent appended meanwhile. Creation is exclusive:
a file that appeared meanwhile makes the create a 409.

Because agents (and humans with an editor) write the files directly, the
manager polls every project's feature files every few seconds and emits
`feature.changed` for any whose mtime moved, so the UI shows a feature
going in progress or landing in review without a refresh. The files are
few and small; a watcher would only add lifecycle to manage.

The first version instead queued features per agent and injected the
spec as a turn, with the manager deriving the outcome from the agent's
state. That was replaced: the injected turn arrived without context, the
agent could neither push back nor be told a caveat, its closing summary
was lost in the transcript, and every safeguard around the queue (runs,
in-progress ownership, outcome from state) was a source of bugs. The
`feature_queue` and `feature_runs` tables from that version are dropped
at startup.

## Daemon integration

- One websocket to the daemon, reconnecting with backoff. On (re)connect a
  resync runs, one agent at a time under that agent's lock so commands
  wait for it: `sessions.list`, adopt sessions labelled
  `agent-manager:<id>` that the database does not know (a running one
  becomes current if the agent has none), then replay every session from
  its own cursor (from the start after a manager restart) through its own
  adapter. Sessions whose replay failed are retried on the next resync; a
  newer resync supersedes one in progress.
- A new session is started unattached, recorded, and only then attached
  with replay from the start, so nothing the process said before the
  manager owned it is lost, and an early exit is reconciled from the
  daemon's record.
- Turns go through `session.input`; the `ok` reply is awaited so the
  manager is flow-controlled by the agent. Commands on one agent
  (turn, interrupt, stop, archive) are serialised.
- A session exit moves the agent to `exited`; an exit that arrives while
  that session is still being replayed is applied after the replay. The
  current pointer is cleared with a conditional update, so a session that
  was already resumed is never un-pointed by a late exit.
- After a reconnect every session whose cursor trails the daemon's
  boundary is caught up, exited or not, so output produced while the link
  was down is not lost. If an earlier session's replay had failed and
  newer history is already shown, the transcript is rebuilt from scratch
  (`agent.reset`) so order is preserved.
- Commands wait for a pending resync (the manager has just started, or
  has just reconnected); waiters are kept across a reconnect that arrives
  meanwhile. Attachments live on the daemon socket, so a disconnect
  invalidates every session until it is re-attached, while "replayed to
  the boundary at least once" is remembered separately so a partial
  replay of older history is detected and triggers the rebuild. An exit
  for a session whose log has not been replayed yet is held until it has,
  and so is its boundary item, whichever path the exit arrives by.
- A new session's id is chosen by the manager and recorded before the
  daemon is asked to start it. If the daemon socket dies while the
  request is in flight the outcome is unknown, so the agent and session
  are kept and the next resync finds out whether the process exists; a
  request refused before it was sent (`not-connected`) is certain, and
  create then leaves nothing behind.
- Stop-like commands give a pending resync a moment to adopt sessions
  and, if it has not reached the agent by then, adopt under the agent's
  own lock before deciding there is nothing to stop.
- A turn whose acknowledgement was lost in flight keeps the agent
  `working`; the next catch-up asks the adapter whether the log actually
  shows an open turn and settles the state from that. Turns catch up the
  current session before judging busy, so a turn that finished during an
  outage is seen. A failed catch-up marks the session incomplete, which
  defers its ended boundary and triggers the rebuild if newer history
  already follows.
- A turn is refused with `agent-unavailable` (503) while the current
  session's output is not attached; the attach is retried first. Any
  daemon failure surfaces as 503 `agent-unavailable`; creating an agent
  while the daemon is unreachable leaves no agent behind. Stop,
  archive and project deletion wait briefly for the agent's lock and, if a
  turn is stuck on a stdin write the agent no longer reads, signal the
  process so the write fails and the command can proceed. Losing the
  daemon during a stop is an error, never taken as an exit.
- Project deletion fences the project (no new agents or turns), stops each
  agent under its lock with a fresh row, deletes the rows, then lifts the
  fence. The
  next turn starts a new session with the adapter's resume args, records
  it under the agent, and sends the turn.
- The manager never sends `session.remove`; logs are kept until a later
  retention feature.

## API

All under `/api`, JSON, cookie-authenticated except `POST /api/auth/login` and `GET /api/health`.

```
POST   /api/auth/login              { name, password }         -> { user }
POST   /api/auth/logout
GET    /api/auth/me
GET    /api/users                                               -> { users: [{ id, name, createdAt, lastLoginAt }] }
POST   /api/users            { name }                           -> 201 { user, password }; the password is shown once
PATCH  /api/users/me         { name }                           -> { user }; only your own name
POST   /api/users/:id/password                                  -> { password }; a new generated one; ends the user's other sessions
DELETE /api/users/:id                                           -> { ok }; not yourself, not the last user

GET    /api/projects                                            -> [{ project, agentCounts: { working, idle, error, ... } }]
POST   /api/projects                { name, repos: [{ name?, path }], defaultProfile? }   (`path` alone is accepted as a one-repo shorthand)
GET    /api/projects/:id
PATCH  /api/projects/:id            same fields; `repos` replaces the whole list, order included. Running agents keep the directories they were started with; see the restart below.
POST   /api/projects/:id/agents/restart -> { restarted: [agentId], skipped: [{ id, why }] }; stops and resumes every idle agent with a live session so it picks up the project's current repositories; agents working, waiting on a permission or with background jobs are skipped with the reason, exited ones need nothing
DELETE /api/projects/:id            (does not touch the repository)

GET    /api/projects/:id/agents                                 -> [{ agent, status }]   status = { state, error, lastActivityAt, background, model, queued }
POST   /api/projects/:id/agents     { name, profile, cwd?, permissions?, model?, effort? } -> starts a session; cwd is a repository name or path, default the primary repo; `permissions` is `bypass` (default) or `ask`; `model` and `effort` are vendor names passed at session start, null for the vendor's default
GET    /api/agents/:id                                          -> { agent, status, sessions }
GET    /api/agents/:id/items?from=I | tail=N | before=I&limit=N       -> { items: [...], total }; from: everything at or after index I (live sync); tail: the last N; before/limit: the N before index I (paging backwards). Indexes are stable.
POST   /api/agents/:id/turn         { text, steer? }            -> 202 { mode: 'sent' | 'steered' | 'queued' }; without `steer`, 409 { code: 'agent-busy' } while a turn runs (with it, the message is steered into the turn or queued for the next one; still 409 while starting or waiting on a permission); 503 { code: 'agent-unavailable' } if the session's output cannot be attached
POST   /api/agents/:id/permission { requestId, option }       -> answers a pending permission request with one of the options the item offered; 404 if none is pending
POST   /api/agents/:id/interrupt
POST   /api/agents/:id/stop         (end input; agent becomes exited, resumable)
POST   /api/agents/:id/archive

GET    /api/profiles                                            -> daemon profiles, each with `supported` (an adapter exists)
GET    /api/health                  (public)                    -> { status: 'ok', daemon: boolean }

GET    /api/projects/:id/files?path=<dir>                       -> { path, entries: [{ name, path, type: file|dir|symlink|other, size, mtime, ignored, status }] }, directories first; the root lists one dir per repository; `ignored` is git check-ignore's verdict (plus `.git` itself) and `status` is git status's (modified|added|deleted|untracked|conflict, a directory taking the most significant of its contents), null when clean; both false/null outside a repository
GET    /api/projects/:id/file?path=<file>                       -> { path, size, mtime, content, binary, truncated }; content empty when binary or over 2 MB
GET    /api/projects/:id/changes?base=<spec>                    -> { base, repos: [{ repo, base, head, note, files: [{ path, status: modified|added|deleted|renamed|untracked, oldPath? }] }] }; spec is `read` (the caller's cursor, default), `feature:<slug>` or a commit-ish; measured against the working tree; `note` says when the base fell back to HEAD (nothing read yet, history rewritten, no range recorded) or when git itself failed, which is never shown as a clean tree
GET    /api/projects/:id/changes/file?path=<repo/path>&base=<spec> -> { path, base, before, after, binary, truncated }; before is the file at the base (null if absent there), after the working file (null if gone)
POST   /api/projects/:id/changes/read { repo? }                 -> sets the caller's read cursor to HEAD in one or every repository
GET    /api/projects/:id/features                               -> { features: [...] } sorted in-progress, review, blocked, planned, done; within a status by priority then slug, except done which is newest first (file mtime, i.e. when it was marked done)
POST   /api/projects/:id/features   { slug, title, body?, priority?, dependsOn?, repo? } -> creates <repo>/features/<slug>.md as planned; repo defaults to the primary
GET    /api/projects/:id/features/:slug
PATCH  /api/projects/:id/features/:slug  { status?, title?, body?, priority?, dependsOn? } -> the human's edits; status may be planned, review, blocked or done (in-progress is the agent's)
POST   /api/projects/:id/features/:slug/respond { text, status? } -> appends a dated "## Response" section; status defaults to planned
```

File paths are `<repository name>/<path inside it>`, normalised, and
`..` is rejected as a correctness rule; an unknown repository name is a
404. Symlinks are followed and nothing else is
contained (see the decisions table). A symlink to a directory lists as a
directory; other symlinks are typed `symlink`. Binary detection is a NUL
byte in the first 8 KB.

Every mutating request must be a JSON object (400 otherwise) and, when the
browser sends an `Origin` header, that origin must be the manager's own
host or `AGENT_MANAGER_PUBLIC_ORIGIN` (403 otherwise). Requests without an
`Origin` header, such as curl, pass.

### Websocket `/api/events`

Authenticated on upgrade with the same cookie. The manager pings every
client on an interval (`AGENT_MANAGER_EVENTS_PING_MS`, 25 s) so an idle
socket carries traffic and reverse proxies keep it open; a client that
has not answered by the next ping is terminated.

One frame goes the other way, client to server, because it is ephemeral
and belongs to the connection: `{ type: 'presence', agentId, typing }`,
sent when the user opens an agent (agentId null when they leave) and
repeatedly while they type. The manager keeps presence in memory per
socket, counts a user once per agent however many tabs they have, lets
typing expire five seconds after the last report, drops a socket's
presence when it closes, and broadcasts `{ type: 'presence', agents: {
[agentId]: [{ userId, name, typing }] } }` whenever the picture changes;
`hello` carries the current picture. This is what lets a squad see who
is looking at an agent and who is mid-sentence before they send a turn
of their own. `hello` also carries `uiBuild`, the id in `build.json` of the UI
directory being served, and the gateway re-reads that file on its ping
tick and broadcasts `{ type: 'ui.build', id }` when it changes, so a
UI-only deploy reaches every open tab without the page polling.
Everything else is server to client; every frame has a
`type`:

```
hello            { user, daemon: { connected }, presence, uiBuild }   // first frame after the upgrade
daemon           { connected }                     // the manager's link to the daemon changed
ui.build         { id }                            // the served UI build changed (a UI-only deploy)
presence         { agents: { [agentId]: [{ userId, name, typing }] } }
users.changed    { users }                         // an account was created, renamed, reset or removed
project.counts   { projectId, counts }
agent.state      { agentId, projectId, status }    // status = { state, error, lastActivityAt, background, model, queued }
agent.item       { agentId, item }                 // item = StoredItem { index, sessionId, seqFrom, seqTo, item }; same index again means an update
agent.session    { agentId, session }              // a new session started or one ended
agent.reset      { agentId }                       // the transcript was rebuilt; refetch items from 0
feature.changed  { projectId, feature }            // a feature file changed (status, report, response, edit)
```

Clients subscribe to nothing; they receive everything for the projects
they can see, which in milestone one is all of them. The websocket is
authenticated with the login cookie on upgrade (closed with 4401
otherwise) and must come from the manager's own origin (4403 otherwise).
Logging out closes that login session's sockets; expired sessions are
swept once a minute.

## Auth

- Users in SQLite, passwords hashed with argon2id.
- Cookie session: an opaque 256-bit random token, HttpOnly, SameSite=Lax,
  Secure when `AGENT_MANAGER_PUBLIC_ORIGIN` is https or
  `AGENT_MANAGER_SECURE_COOKIE=1`; server-side session table so logout is
  real and open sockets are closed with it.
- Login attempts are limited per client address (default 10 per minute,
  then 429) and Argon2 verification runs with a small concurrency bound;
  unknown users cost the same as known ones.
- First admin: `AGENT_MANAGER_ADMIN_PASSWORD` on first start creates
  `admin`, or `npm run user:add -- <name>`.
- No roles: every user is a trusted admin and sees every project. There
  is no other kind of account, because every user can drive agents that
  run with permissions bypassed anyway; a squad on one box shares one
  trust level. Accounts exist only because an admin created them: the
  manager generates the password (four groups of four unambiguous
  characters), shows it once and never stores it in the clear. Users
  rename themselves; anyone can generate a new password for anyone
  (behind a confirm in the UI, logged by the manager), which ends that
  user's other login sessions so a forgotten password cannot linger as a
  live session; anyone can remove anyone but themselves, never the last
  user. A lost password is a reset, never a recovery.
- `users.changed` is broadcast on every account change so headers and
  user lists stay current.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_MANAGER_LISTEN` | `0.0.0.0:4268` | bind address; behind haproxy for TLS |
| `AGENT_MANAGER_DAEMON_URL` | `ws://127.0.0.1:4267/` | the daemon |
| `AGENT_MANAGER_DATA_DIR` | `~/.local/state/agent-manager` | `manager.db` and the `transcripts/` cache |
| `AGENT_MANAGER_UI_DIR` | `<install>/ui` (next to `dist/`) | built UI to serve at `/`; empty string disables |
| `AGENT_MANAGER_PUBLIC_ORIGIN` | unset | e.g. `https://agents.example`; accepted by the origin check and, when https, turns on Secure cookies |
| `AGENT_MANAGER_SECURE_COOKIE` | `0` | force Secure cookies |
| `AGENT_MANAGER_LOGIN_ATTEMPTS_PER_MINUTE` | `10` | login throttle |
| `AGENT_MANAGER_SESSION_TTL_MS` | `2592000000` (30 days) | how long a login (browser cookie or `am login`) lasts |
| `AGENT_MANAGER_TRUSTED_PROXIES` | unset | comma-separated proxy addresses whose `X-Forwarded-For` gives the client address; set it behind HAProxy or every user shares one throttle |
| `AGENT_MANAGER_BACKGROUND_POKE_MS` | `1800000` | an agent idle with background jobs and no activity for this long is sent a short turn asking it to check on them (at most once per interval); 0 disables |
| `AGENT_MANAGER_RESIDENT_ITEMS` | `500` | transcript items kept in memory per agent beyond what the transcript cache holds |
| `AGENT_MANAGER_EVENTS_PING_MS` | `25000` | interval of websocket pings on `/api/events`; keeps idle sockets alive through reverse proxies (haproxy drops idle tunnels after 50 s by default) and detects dead clients |
| `AGENT_MANAGER_ADMIN_PASSWORD` | unset | creates the first admin on first start |

The built UI's static assets and the SPA fallback are served without
authentication: the login page must load. Everything under `/api` except
login and health requires the cookie.

## Testing

- Unit: adapters against recorded logs; state machine; feature file
  parsing; path resolution.
- End-to-end: a real daemon on an ephemeral port (`../agent-daemon/dist/main.js`,
  or `AGENT_DAEMON_MAIN`) with the fake profile, the manager on an
  ephemeral port, supertest for REST and `ws` for events. Covers login,
  project and agent lifecycle, turns and items through the fake agent,
  manager restart with state rebuilt from the daemon.
- Opt-in smoke (`npm run smoke:agents`): a throwaway daemon and manager
  on ephemeral ports, one real turn through each of Claude, Codex and
  Copilot; costs tokens; never touches the installed services.
- `test/lifecycle.e2e-spec.ts` runs the manager against `test/scripted-daemon.ts`,
  a daemon the test drives frame by frame (a ws server speaking the part
  of the daemon protocol the manager uses, with a log per session that
  survives a cut connection) and a tiny scripted Codex behind it. It cuts
  the connection at each handshake point, refuses, loses and records
  permission answers, rejects an interrupt, loses a turn's
  acknowledgement, and restarts the manager while a permission waits. No
  processes, no tokens. These are the cases the review rounds found by
  hand; a change to replay, attribution or permissions should add its
  case here.


## Running it

A systemd user service like the daemon, installed by
`npm run install:service`, serving the UI build copied in from
`agent-manager-ui/dist`. The manager may be restarted freely; agents keep
running in the daemon and are re-adopted on start.

## Milestones

1. **Usable**: auth, projects, agents, the Claude adapter and the fake
   adapter, state and items, REST and events, rebuild-from-daemon. UI:
   login, project list with counts, agent view with transcript and turn
   input.
2. **Files** (done): tree and file endpoints; UI file browser with Monaco,
   read-only, refreshed when an agent in the project finishes a turn.
3. **Features** (done): `features/*.md` convention, parsing, listing,
   the human's writes (create, respond, status) and a poller that turns
   the agent's own edits into events. The first cut queued features as
   injected turns; replaced, see "Features" below.
4. **Codex and Copilot adapters** (done): tested against recorded
   sessions, and end to end by `npm run smoke:agents`.
5. **Changes** (done): a diff from a base to the working tree per
   repository, with a read cursor per user ("what changed since I last
   looked") and a range per feature; the UI shows the changed files and a
   Monaco diff. See "Changes" in the API and the decisions table.
6. **Interactive permissions** (done): `permissions: ask` per agent, the
   vendor's gate routed to the human as a transcript item. See the
   decisions table and Adapters.
7. **Bounded transcript history** (done): items are materialised per
   session in a cache the manager can always rebuild from the daemon
   log; a live agent keeps only a tail resident, a restart replays only
   what the cache does not have, archived agents are loaded when opened,
   the items endpoint pages backwards. See "Transcript cache".
8. Later, each needing its own discussion:
   worktrees and multi-agent coordination;
   idle timeout and automatic resume; clone-from-URL; roles; log
   retention.

## Open questions

- Whether `waiting-input` is derivable for Claude at all, or whether "idle
  after a turn whose last text ends in a question" is as good as it gets.
- Streaming granularity for `agent.item`: per delta, or coalesced on a
  short timer to spare the UI.
