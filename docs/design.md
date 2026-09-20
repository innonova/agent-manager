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
Agent     { id, projectId, name, profile, cwd, permissions: bypass | ask, model | null, effort | null, harnessNote | null, createdBy | null, vendorConversationId | null,
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

The status also carries `usage`, what the vendor last said about its
account's limits through this agent: rolling windows (every window
Claude's `rate_limit_event` carries: the 5-hour and 7-day ones, the
"overage included" one shown as `fable` since that is the figure
Claude Desktop labels Fable, and any per-model family window it adds;
Codex's primary and secondary from `account/rateLimits/updated`, named
by their length) with used percent and reset time, a verdict when the
vendor gives one, the plan; the session's `spend` (tokens in and out,
turns, and dollars when the vendor prices them: Claude's `result`,
whose cost is the session's running total, Codex's
`thread/tokenUsage/updated`, one per model call, counted once per
turn), and, once the agent has been restarted, `total`: the vendor's
counters start over with each session, so the manager adds the earlier
sessions' final spend (kept per session in the transcript cache) to the
current one's, which is what the UI shows; each report carries its
record's time, and the manager keeps the newest per profile, seeded
from the cached status after a restart; the `provider` when Claude says
(firstParty, bedrock, vertex); and the context window's use (Codex,
Copilot). On Bedrock or Vertex there are no account windows, so spend
and provider are the usage there is. Copilot exposes no account quota
over ACP. The manager keeps the latest report per profile, the account on
this machine, and `GET /api/usage` lists them per host (a hub merges its
spokes'). Nothing polls the vendors: usage is what agents report while
they work.

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

The status also carries `activity`, a compact read of the last thing on
the stream: `{ kind: 'requesting' | 'thinking' | 'writing' | 'tool' |
'waiting'; detail?: string; tokens?: number; since: number } | null`.
`requesting` is a request to the model out with nothing back yet
(Claude's `system` subtype `status` with `status: 'requesting'`, one
before every message of a turn), `thinking` is a reasoning delta
(Claude's `thinking` blocks, Codex's `reasoning` item,
Copilot's `agent_thought_chunk`), `writing` is an output text delta
(Claude's `text` blocks, Codex's `item/agentMessage/delta`, Copilot's
`agent_message_chunk`), `tool` is a tool call under way, `detail` naming
what runs (a shell tool's command, first line trimmed to ~80 chars; a
read or edit's path; otherwise the tool's name), and `waiting` is a
permission request or an `ask` left open. Claude's `tool_progress`
heartbeats (every 30 s of a long call) re-report the call as it stands,
so `since` keeps saying when it began; a heartbeat for any other call is
ignored. `tokens` is how much the agent has produced, as the vendor
reports it while streaming, reset per turn. While `thinking`, it is
Claude's live estimate of the stretch under way (`thinking_tokens`
records, or a `thinking_delta`'s own `estimated_tokens` when those do
not arrive), cumulative within the stretch and counted from zero at the
next one, so it ticks every few hundred ms instead of standing still
until the message ends. Otherwise it is the turn's settled output:
Claude's cumulative `usage.output_tokens` summed across a turn's
`message_delta` events (a tool-use turn is several Claude messages,
each ending with its own), Codex's summed from `thread/tokenUsage/updated`'s
`last.outputTokens`, always accumulated regardless of timing but shown
only when attached to an item still open when the report arrives: an
item completing clears the adapter's notion of "current", so a report
landing in the gap after one closes and before the next opens is kept
(the sum is right) but not displayed until something is open to show it
against, and a just-finished call is never redisplayed with a fresher
count as if still running. The two counts are different quantities, so
the number can step down when a thinking stretch gives way to text: the
estimate of what was just thought is replaced by what the turn has
settled so far. Absent, not a misleading 0, before either
vendor has said anything, and always absent for Copilot, which reports
nothing usable mid-turn. `since` is the record time the current activity began, so a
client can say "thinking for 12 s"; `null` outside a turn. The split
follows the adapter/service line everywhere else: an adapter's `ingest`
returns a bare `{ kind, detail?, tokens? } | null` hint on `thinking`,
`writing` and `tool` records only (`undefined` when a record says
nothing about it), and the service turns that into the full value, adds
`since`, derives `waiting` from the `waiting-permission` state and
clears it (to `null`) at every other state transition — a turn
beginning or ending has nothing to show yet, so an adapter never
reports `waiting` or a clear itself. Announced as part of `agent.state`
on change (a `tokens` change with the same `kind` and `detail` counts,
but does not restart `since`) like the rest of the status. A change of
what it does (thinking to a tool, one tool to the next) is announced at
once, or a reader would see the transcript's tool call a second before
the line says so; only a `tokens` count growing within the same
activity is coalesced to at most one announcement a second, so token
ticks do not flood the socket. A state transition's own `activity`
(`waiting`, or a clear) is never throttled either.
The fake agent's `status`, `thinking`, `thinking_tokens` and `tool_use`
outputs carry the same hints, and its streamed text carries a `tokens`
count too (one per word, reset per turn, its own stand-in for a vendor's
running total), so tests can see `activity` change mid-turn, a request
in flight, a thinking estimate ticking, and all of it clear at the
turn's end.

A commit the vendor reports (Claude's `system` subtype
`vcs_state_changed` with kind `commit`) comes back from the adapter as
`committed: { branch?, cwd? }` and becomes a system item in the
transcript ("committed on main"), so a reader sees work landing where it
happened; the run log takes the same signal.

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

## The harness note

The vendors' CLIs know nothing about the manager. Left alone, an agent
assumes a person at a terminal, treats a mid-turn message as a new
prompt, and has never heard of the features convention; the four
repositories of this system carry that in their `CLAUDE.md` and
`AGENTS.md`, any other project does not. So the manager tells every
agent, at every session start, what it is running under: a short note
with only what the harness adds and the CLIs cannot know (nothing the
CLI already tells its model: the working directory, the extra
directories Claude and Copilot get as `--add-dir`), as description
rather than procedure: that there is no terminal, someone may follow
along in the web UI or read much later, and a question or permission
request waits there (the permission mode itself is the CLI's own
setting, enforced by it, not restated), that a mid-turn message is a
person's and a held one arrives as the next turn, that the manager
itself asks about long-running background jobs, where uploads land, the
project's repositories (Codex has no other way to know them), and the
features convention described well enough for a repository that has not
started using it.

The note is built from a template with `{{agent}}`, `{{project}}`,
`{{host}}`, `{{profile}}`, `{{cwd}}`, `{{permissions}}`, `{{repos}}` and
`{{models}}` placeholders. All but the last render a value inline;
`{{models}}` brings its own heading, rendering `## Models` followed by
the models file's text, and nothing at all when that file is empty, so
turning the house view off leaves no empty section behind (a run of
blank lines left by a placeholder that rendered nothing is collapsed). The shipped text is `harness.md` at the repository root,
installed next to `dist/`; the installer copies it to
`~/.config/agent-manager/harness.md` (`AGENT_MANAGER_HARNESS_FILE`)
when there is no copy, or when the copy is still the text the previous
install shipped (unchanged by the operator; the previous text is the
one in the install directory, read before it is replaced), and keeps
an edited copy, saying so. That copy is what runs, read at each session start so an edit needs no
restart of the manager; a missing copy falls back to the shipped file,
an empty one turns the note off. Each vendor
has a per-process channel, so the note is supplied afresh with every
session and a changed one reaches an agent at its next restart (the
project's "save and restart agents", or `am project restart`):

- Claude: `--append-system-prompt`, on a resume too;
- Codex: `developerInstructions` on `thread/start` and `thread/resume`;
- Copilot: nothing over ACP, but the CLI reads `copilot-instructions.md`
  from the directories `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` names, so the
  manager writes the note to `<dataDir>/harness/<agentId>/` and names
  that directory in the session's environment (and removes it when the
  note is off, so a stale one is not read);
- the fake agent takes `--note` and repeats it on a "note" turn, which
  is how the e2e test sees what was told.

The note as rendered at the last session start is kept on the agent
(`harnessNote`), so the UI can show what the agent was told. A spoke
renders its own notes from its own template; `GET`/`PUT /api/harness`
read and write the template per machine (the hub forwards by host
name), which is how the UI edits it without a shell.

The models file is the second file of this kind: `models.md` beside
`harness.md`, the house view of which model suits which work, so an
agent that starts a helper chooses with what we have learned in front
of it. It behaves exactly as the note's template does — shipped at the
repository root, installed next to `dist/`, seeded by the installer
with the same three-way rule (seed, update while unedited, keep an
edited copy and say so), read at every session start, missing falling
back to the shipped text and empty turning it off — and is read and
written over `GET`/`PUT /api/models`, forwarded by a hub the same way.
Its row has the same shape as the harness one, including the field
name `template`: the models file has no placeholders, so the name is a
misnomer kept on purpose, because it lets the UI edit both files with
one editor. One difference: the models text is pasted into every note
of every agent, so `PUT` caps it at 8 KB where the template's cap is
64 KB, and says so.

Three decisions about it:

- An agent is told the house view in its note and nowhere else. The
  text it has is the one rendered at its session start, frozen until
  its next restart, and an agent's token is refused `/api/models` as it
  is refused `/api/harness`. Keeping it from drifting mid-turn is worth
  more than letting an agent re-read it.
- Both files are per machine, which fits the note (it describes the
  machine) but not the models (what we have learned is not a property
  of a box), and will not fit the run log either. A hub-wide copy that
  spokes inherit is the later decision; until it is taken, a hub's
  operator edits each machine's copy through the UI's host rows.
- The file is free text, one section per model, and nothing parses it.
  Model choice stays a person's or an agent's judgement; the manager
  does not act on it.

The run log (`features/run-log-for-model-comparison.md`) is where the
evidence behind the file accumulates; the file itself is the conclusion,
kept by hand.

## Adapters

```ts
interface AgentAdapter {
  /** state right after the process starts; default 'starting' */
  readonly initialState?: AgentState;
  /** args to add to the profile for a new conversation, or to resume one; extra repositories, permission mode, model, effort and the harness note */
  startArgs(opts: { resume?: string | null; extraDirs?: string[]; permissions?: 'bypass' | 'ask'; model?: string | null; effort?: string | null; note?: string | null }): string[];
  /** for a vendor that reads instructions from a file: its name, and the environment naming the directory the manager wrote it to */
  readonly noteFile?: string;
  startEnv?(opts: { noteDir: string }): Record<string, string>;
  /** the stdin line(s) for a user turn */
  turn(text: string): unknown[];
  /** the stdin line(s) to interrupt the current turn, if the vendor supports it */
  interrupt?(): unknown[];
  /** the stdin line(s) for a message the agent sees at its next step of the turn under way; absent or empty means queue it */
  steer?(text: string): unknown[];
  /** stdin lines to send once the session is running and attached (protocol handshakes) */
  startLines?(opts: { cwd: string; resume?: string | null; note?: string | null }): unknown[];
  /** after a full replay of the log: the handshake lines still owed, judged from what the log shows was sent and answered */
  afterReplay?(opts: { cwd: string; resume?: string | null; permissions?: 'bypass' | 'ask'; note?: string | null }): unknown[];
  /** whether a turn is open as far as the log shows */
  turnInProgress?(): boolean;
  /** permission requests the vendor is waiting on; and the stdin line answering one with an option */
  pendingPermissions?(): PermissionRequest[];
  decide?(requestId: string, option: string): unknown[];
  /** cross-turn state at a turn end as JSON, and its inverse, for the transcript cache */
  snapshot?(): unknown;
  restore?(state: unknown): void;
  /** feed one daemon log record; returns state changes, transcript operations and lines to send in reaction */
  ingest(record: LogRecord): { state?: AgentState; error?: string; model?: string; background?: number; activity?: { kind: 'requesting' | 'thinking' | 'writing' | 'tool'; detail?: string; tokens?: number } | null; committed?: { branch?: string; cwd?: string }; ops?: ItemOp[]; conversationId?: string; send?: unknown[] };
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
  with `is_error`, or as `error`-typed lines. Beside the content it
  reads the stream's own progress records: `system` subtypes `status`
  (a request in flight), `thinking_tokens` (the live estimate of the
  thinking under way) and `vcs_state_changed` (a commit), and
  `tool_progress` heartbeats for a long call.
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

## Hub and spokes: several machines in one UI

A manager can front for other managers, so one UI (and one login)
covers several machines. Each machine keeps its own daemon and manager
exactly as before, because a manager's files, changes and features read
the repositories on its own disk; what is shared is the view.

- **Spoke**: a manager with `AGENT_MANAGER_HUB_TOKEN` set accepts
  requests and websocket upgrades carrying `Authorization: Bearer
  <token>` plus `X-Acting-User: <name>`; they run as that user, created
  on the spoke on first sight with a password that cannot be used (the
  hub is their only way in). Turns are attributed and presence is shown
  under that name, so the spoke's own UI sees the same names as the hub.
- **Hub**: a manager with `<dataDir>/spokes.json` (`[{ name, url,
  token }]`, `AGENT_MANAGER_SPOKES_FILE` overrides the path; the file
  must be readable by this user only, or it is ignored as a whole, and
  a name that repeats or is this machine's own, or a bad url, ignores
  it too; errors never quote an entry). It lists
  the spokes' projects beside its own, each project carrying `host`, and
  every id of a spoke's project or agent is seen as `<name>:<id>`. A
  request about such an id (`/api/projects/<name>:<id>/...`,
  `/api/agents/<name>:<id>/...`) is forwarded to the spoke as the user
  making it, with the reply's ids prefixed back; `POST /api/projects`
  with `host` creates on that spoke; `GET /api/projects/:id/profiles`
  gives the profiles of the machine the project is on. The hub keeps
  one socket to each spoke's `/api/events` and fans its frames into its
  own stream with the ids prefixed; the spokes' presence is merged into
  the hub's own picture (so one `presence` frame still says everything);
  their `users.changed` and `ui.build` are not forwarded. A spoke's
  socket is given ten seconds to open and is dropped after ninety
  seconds without a ping or a frame; when it comes back the hub sends
  `host.reconnected { name }`, on which clients refetch what they show of
  that machine, since whatever the spoke sent meanwhile is gone. Ids
  forwarded to a spoke must be plain (`[A-Za-z0-9-]`) and every path
  segment after them a plain name (no dot segments, nothing
  percent-encoded a URL parser would fold), so a request cannot leave
  the project and agent routes there. A spoke's agent viewed both on
  the spoke and on the hub lists both sets of people, once each. A 401 or 403 from a
  spoke is the hub's credential being refused and is reported as 502
  `spoke-auth`, never as the user's own login expiring. Nothing about a
  spoke is stored on the hub; `spokes.json` is the whole configuration.
- **Hosts**: `hello` and the `hosts` frame carry `[{ name, local,
  connected, daemon, error? }]`, the hub's link to each spoke, each
  host's link to its daemon, and what the last request to a spoke said
  when it failed; `/api/health` has the same list. A spoke that does
  not answer contributes no projects to the list and its requests fail
  with 502 `spoke-unreachable`; the hub reconnects with backoff.
- Every machine is named (`AGENT_MANAGER_HOST_NAME`, default the short
  hostname); the local host's projects carry it too, so clients treat
  all hosts alike.

Not shared: user accounts (the hub's users are the ones that log in;
spokes see them by name, and a user a hub created cannot be given a
password on the spoke: it logs in on the hub), presence sent by the
hub's users about a spoke's agents (shown on the hub, not on the spoke),
and the CLI, which runs on a machine and talks to that machine. Anyone
holding a spoke's token can act there as any name, `admin` included:
the token is a credential for the whole spoke, which is why the file
holding it must be private.

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

## Images with a turn

A turn may carry images, pasted into the web UI or given to the CLI.
They travel as base64 in the same input line as the text, each vendor
in its own shape (Claude an `image` content block, Codex an `image`
input with a data URL, Copilot an ACP `image` block; the fake agent
counts them), so the daemon log holds them and a transcript rebuilt from
the log shows them again: the user item carries `images` exactly as
sent. That is the reason for the limits (four per turn, three megabytes
each, six per turn): the daemon takes lines up to ten megabytes, and the
transcript cache and the items pages carry whatever the log carries. A
pasted screenshot is a few hundred kilobytes; if large images become
common, storing them beside the log is the change to make. Messages
held for the next turn are bounded too (twenty, and 24 MB of images
among them), refused as busy beyond that.

## Uploads and directories

The files view can write, in two small ways: `PUT
/api/projects/:id/file` puts a raw body at a path inside a repository,
and `POST /api/projects/:id/dir` creates a directory there. That is
all: the file is then part of the working tree like anything else,
untracked until committed, seen by the changes view and readable by the
agent with its own tools; the manager keeps nothing about it. A path is
validated as on the read side (`..` refused, the first segment a
repository name). An existing file is not replaced without
`overwrite=1` (and then keeps its mode, so a script stays executable
and a private file private), a new file is linked into place so two
uploads racing for one name cannot both win, a missing parent is not
created by an upload (the directory route is for that), and a file is
at most 25 MB. Uploads travel through a hub to a spoke as bytes.

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
  | { kind: 'user'; text: string; by?: string; images?: [{ mediaType, data }] }   // by: the user who sent it; images: base64, as they went to the agent
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
file. A repository's name is the one given at creation, or the directory's
basename for a project created with a single path. A new feature is
created in the primary repository unless the request names another (the UI always uses the primary: which repository
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
what changed, what was verified, what is left open and what was
noticed and left alone (see `docs/method.md`), and sets
`status: review` (or `blocked`, with the reason in the report). The human
reads the report in the UI, answers under a dated `## Response` and sets
the status back to `planned`, or marks it `done`. An agent asked to
work through several features re-reads the directory before finishing
and takes up anything planned that appeared meanwhile. This is spelled
out for agents in each repository's `CLAUDE.md`.

Helpers and batches. An agent can delegate: with its session token it
starts another agent in its project (`am new`), gives it work (`am
turn --quiet`, `am wait`), reviews its report and the feature's commit
range, records the outcome on the run (`am runs review`) and forgets it
(`am delete`) once the work is gated. One writer per repository still
holds. How a helper is run (orientation, a plan per feature with the
verification first, briefs as shape not route, the three scopes,
batches and their gate, looking at UI work, closing the loop with a
cause, debriefs) is the practice in `docs/method.md`; the mechanisms it
uses are specified here.

A feature's work spans a range of commits per repository: the manager
records HEAD as the base when it first sees the feature in progress
(the agent sets that; the poller notices within seconds, before any
commit of the work; a feature already in progress when the manager
first indexes a project is history, not a transition, so it gets no
base and opens no run) and HEAD as the end when it is marked done. Later
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

## Runs

A run is one agent's work on one feature, recorded so that models can be
compared on real work: which model did what, at what cost, with the
diff and the transcript beside the numbers. The pieces exist already
but scattered and perishable — the commit range on the feature, the
transcript in the daemon's log (gone with the agent), the model on the
agent row, the spend on the status — so a run copies what it needs and
keeps it.

A run opens when a feature goes `in-progress` and closes when it leaves
it (`review`, `blocked`, `done`). The transitions come from the same
watch that records the commit range: the feature poller calls its
transition hooks after the range is recorded, so a run always has the
base commit the diff view uses. The run is attributed to the agent
working in the feature's own repository, else to the only agent working
in the project; with no candidate there is no run, since numbers that
belong to nobody are worse than none.

Three safety nets close a run that never sees its feature move: the
agent exits, the agent is forgotten (a hook that runs before its
transcript is deleted, so the export still has something to read), or
nothing happens for `AGENT_MANAGER_RUN_IDLE_MS` and the run is closed
as `abandoned`. `outcome` says which of the four it was. A run closed
because the agent's process exited does not reopen when the agent
resumes: the next round of the feature is the next run.

What a run records, in the `runs` table (no foreign keys, the agent's
identity copied in: the log is the point after the agent and even the
project are gone) and one NDJSON file per run under `<dataDir>/runs/`:

- the agent (id, name, profile, model, effort, permissions), the host,
  the project, the repository and the feature slug;
- when it started and ended, the status the feature ended in, and the
  outcome;
- the repository's HEAD at each end: a run that committed nothing shows
  the same hash twice;
- what the vendor says the work cost, as the difference of its running
  totals between the two ends (the totals at the start are kept on the
  row, so the difference survives a restart of the manager). Every
  field is `null`, not `0`, when the vendor said nothing during the
  run: no data and free are different things, and Copilot reports
  nothing usable at all;
- the transcript of the window, exported to the run's file when it
  closes, as the same `StoredItem` lines the transcript cache holds, so
  one reader serves both. The window is the agent's item indexes
  between the two ends, which is everything that agent did while the
  run was open — a person talking to it meanwhile is in there too, and
  that is the honest record rather than a filtered one;
- the report the agent appended to the feature (its last `## Report`
  section), as text.

Run files are kept indefinitely. They are small, and outliving the
agent is the whole point; nothing prunes them.

The routes are a human's, like the harness and models files: an agent's
token is refused them. There is no UI page in this round — a block on
the projects page can follow once we know what we want to look at — and
`am runs` belongs to `agent-manager-cli`.

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

All under `/api`, JSON, cookie-authenticated except `POST /api/auth/login` and `GET /api/health`;
a spoke also accepts a hub's bearer token with an acting user (see Hub and
spokes).

```
POST   /api/auth/login              { name, password }         -> { user }
POST   /api/auth/logout
GET    /api/auth/me
GET    /api/users                                               -> { users: [{ id, name, createdAt, lastLoginAt }] }
POST   /api/users            { name }                           -> 201 { user, password }; the password is shown once
PATCH  /api/users/me         { name }                           -> { user }; only your own name
POST   /api/users/:id/password                                  -> { password }; a new generated one; ends the user's other sessions
DELETE /api/users/:id                                           -> { ok }; not yourself, not the last user

GET    /api/projects                                            -> [{ project, agentCounts: { working, idle, error, ... } }]; project.host names the machine; as a hub, the spokes' projects too, ids `<host>:<id>`
POST   /api/projects                { name, repos: [{ name?, path }], defaultProfile?, host? }   (`path` alone is accepted as a one-repo shorthand; `host` creates on that spoke)
GET    /api/projects/:id/profiles                               -> { profiles } of the machine the project is on
GET    /api/projects/:id
PATCH  /api/projects/:id            same fields; `repos` replaces the whole list, order included. Running agents keep the directories they were started with; see the restart below.
POST   /api/projects/:id/agents/restart -> { restarted: [agentId], skipped: [{ id, why }] }; stops and resumes every idle agent with a live session so it picks up the project's current repositories; agents working, waiting on a permission or with background jobs are skipped with the reason, exited ones need nothing
DELETE /api/projects/:id            (does not touch the repository)

GET    /api/projects/:id/agents                                 -> [{ agent, status }]   status = { state, error, lastActivityAt, background, model, queued, activity }
POST   /api/projects/:id/agents     { name, profile, cwd?, permissions?, model?, effort? } -> starts a session; cwd is a repository name or path, default the primary repo; `permissions` is `bypass` (default) or `ask`; `model` and `effort` are vendor names passed at session start, null for the vendor's default
GET    /api/agents/:id                                          -> { agent, status, sessions }
GET    /api/agents/:id/items?from=I | tail=N | before=I&limit=N       -> { items: [...], total }; from: everything at or after index I (live sync); tail: the last N; before/limit: the N before index I (paging backwards). Indexes are stable.
POST   /api/agents/:id/turn         { text, steer?, images? }   -> 202 { mode: 'sent' | 'steered' | 'queued' }; images: [{ mediaType, data }] base64, png/jpeg/gif/webp, at most 4, 3 MB each and 6 MB per turn (400 otherwise); without `steer`, 409 { code: 'agent-busy' } while a turn runs (with it, the message is steered into the turn or queued for the next one; still 409 while starting or waiting on a permission); 503 { code: 'agent-unavailable' } if the session's output cannot be attached
POST   /api/agents/:id/permission { requestId, option }       -> answers a pending permission request with one of the options the item offered; 404 if none is pending
POST   /api/agents/:id/interrupt
POST   /api/agents/:id/stop         (end input; agent becomes exited, resumable)
POST   /api/agents/:id/restart      -> { ok }; stops and resumes this agent with the current settings (repositories, harness note), conversation intact; an exited one is started; 409 while working, waiting on a permission or with background jobs
POST   /api/agents/:id/archive
DELETE /api/agents/:id             -> { ok }; forgets the agent for good: process stopped, the daemon's logs of its sessions removed, transcript cache and rows gone (the vendor's own conversation store stays); for helpers whose work is in git and the feature's report
GET    /api/projects/:id/agents?archived=1                      -> the archived agents instead, newest first

GET    /api/profiles                                            -> daemon profiles, each with `supported` (an adapter exists)
GET    /api/usage                                               -> { hosts: [{ host, accounts: [{ profile, agentId, usage }] }] }; the vendor accounts' limits as last reported through an agent, per machine
GET    /api/harness                                             -> { hosts: [{ host, source: built-in | custom | off, template, builtIn, file }] }; the harness note's template per machine (a hub asks its spokes)
PUT    /api/harness                 { host?, template: string | null } -> the host's row; writes the template file (empty turns the note off), null writes the shipped text back into it; `host` names a spoke to write there
GET    /api/models                                              -> { hosts: [...] }; the models file per machine, same row shape as /api/harness (its `template` field is the file's text; it has no placeholders)
PUT    /api/models                  { host?, template: string | null } -> the host's row; as /api/harness, capped at 8 KB because the text goes into every agent's note
GET    /api/runs?project=&feature=&model=&since=&limit=         -> { runs: [...] }; the run log, newest first (see Runs); `project` may name a spoke's project (`<spoke>:<id>`), which forwards and prefixes the ids it returns
GET    /api/runs/:id                                            -> { run, transcript: [StoredItem] }; the run and the transcript exported when it closed (empty when there is none); a prefixed id forwards to its spoke
GET    /api/health                  (public)                    -> { status: 'ok', daemon: boolean, hosts: [{ name, local, connected, daemon }] }

GET    /api/projects/:id/files?path=<dir>                       -> { path, entries: [{ name, path, type: file|dir|symlink|other, size, mtime, ignored, status }] }, directories first; the root lists one dir per repository; `ignored` is git check-ignore's verdict (plus `.git` itself) and `status` is git status's (modified|added|deleted|untracked|conflict, a directory taking the most significant of its contents), null when clean; both false/null outside a repository
GET    /api/projects/:id/file?path=<file>                       -> { path, size, mtime, content, binary, truncated }; content empty when binary or over 2 MB
PUT    /api/projects/:id/file?path=<file>[&overwrite=1]         raw body -> { path, size, replaced }; writes the file into a repository (at most 25 MB; 404 if the directory is missing; 409 if the file exists without overwrite)
POST   /api/projects/:id/dir        { path }                    -> 201 { path, created }; creates the directory and missing parents inside a repository (409 if a file is in the way)
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
hello            { user, daemon: { connected }, presence, uiBuild, hosts }   // first frame after the upgrade
hosts            { hosts: [{ name, local, connected, daemon, error? }] }   // a host's link changed (a hub's spokes, or this machine's daemon)
host.reconnected { name }                          // a spoke's stream is back after a gap: refetch what you show of it
daemon           { connected }                     // the manager's link to the daemon changed
ui.build         { id }                            // the served UI build changed (a UI-only deploy)
presence         { agents: { [agentId]: [{ userId, name, typing }] } }
users.changed    { users }                         // an account was created, renamed, reset or removed
project.counts   { projectId, counts }
agent.state      { agentId, projectId, status }    // status = { state, error, lastActivityAt, background, model, queued, activity }
agent.item       { agentId, item }                 // item = StoredItem { index, sessionId, seqFrom, seqTo, item }; same index again means an update
agent.session    { agentId, session }              // a new session started or one ended
agent.reset      { agentId }                       // the transcript was rebuilt; refetch items from 0
agent.removed    { agentId, projectId }            // forgotten for good; drop it
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
- Agent tokens: every session start issues the agent a bearer token
  (`AGENT_MANAGER_TOKEN`, with `AGENT_MANAGER_URL`, in the process
  environment; only its hash is kept, in `agent_tokens`), so `am` in the
  process is logged in as a user named `agent-<name>`. The token is
  scoped to the agent's project: its agents, features, files and
  profiles, the project list, and its project's run log; not users, the
  harness template,
  other projects, or the project's own settings and bulk restart. A
  guardrail against a helper wandering, not a security boundary (the
  process runs as the manager's own user). Replaced at each session
  start, revoked by archive and forget.
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
| `AGENT_MANAGER_RUN_IDLE_MS` | `7200000` (2 h) | an open run whose agent has done nothing for this long is closed as `abandoned`; 0 disables |
| `AGENT_MANAGER_RESIDENT_ITEMS` | `500` | transcript items kept in memory per agent beyond what the transcript cache holds |
| `AGENT_MANAGER_EVENTS_PING_MS` | `25000` | interval of websocket pings on `/api/events`; keeps idle sockets alive through reverse proxies (haproxy drops idle tunnels after 50 s by default) and detects dead clients |
| `AGENT_MANAGER_ADMIN_PASSWORD` | unset | creates the first admin on first start |
| `AGENT_MANAGER_HOST_NAME` | the short hostname | how this machine is named in `project.host` and to a hub |
| `AGENT_MANAGER_HUB_TOKEN` | unset | lets a hub act here with this bearer token (see Hub and spokes) |
| `AGENT_MANAGER_SPOKES_FILE` | `<dataDir>/spokes.json` | the spokes this manager fronts for; absent means not a hub |
| `AGENT_MANAGER_HARNESS_FILE` | `~/.config/agent-manager/harness.md` | template of the note every agent gets at session start (see The harness note); seeded from the shipped `harness.md` by the installer, absent falls back to it, empty means none |
| `AGENT_MANAGER_MODELS_FILE` | `~/.config/agent-manager/models.md` | the house view of the models, rendered into every note at `{{models}}`; seeded from the shipped `models.md` by the installer, absent falls back to it, empty means no Models section |

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
