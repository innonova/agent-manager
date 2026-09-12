# agent-manager design

Status: milestone one implemented 2026-09-12; kept in step with the code.

## The system

Three components, three repositories, one machine (an isolated VM):

```
agent-manager-ui  (Vue)      browser; renders what the manager tells it
      │  https, cookie session, REST + one websocket
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
| Permissions bypassed by default | The VM is isolated for exactly this purpose, and humans approving tool calls one by one is the weaker control anyway. Interactive permissions are a later, opt-in feature; the state model reserves a state for it. |
| Agents work directly in the repository, one writing agent per repo | A single agent outpaces the human providing ideas; direct work keeps the file view live. The manager warns, but does not prevent, two agents sharing a cwd. Worktrees are a later milestone. |
| SQLite (better-sqlite3) for manager state | Small, local, transactional, no server. What it holds is tiny; transcripts are not stored, they are rebuilt. |
| Cookie session with argon2 passwords | Simplest thing that is actually secure for a small user list. The cookie carries an opaque 256-bit server-side token rather than a signed value; revocation is a row delete. |
| One turn at a time per agent | Neither vendor lets a queued turn be represented faithfully in the transcript, so a second turn while one runs is refused with 409 `agent-busy`; the UI offers interrupt instead. |
| Archived agents keep their history | Archival hides an agent from lists and refuses commands; its transcript is still rebuilt and readable. |
| Features are markdown files in the project repo | Versioned with the code, readable by the agent, editable by the human in any editor. |
| A fake adapter and fake profile exist from day one | UI development and end-to-end tests must not cost tokens. |
| Adapters are tested against recorded daemon logs | The daemon's logs are exact transcripts; a vendor protocol change becomes a fixture diff. |
| Git status/diff is out of milestone one | Needs its own discussion; GitHub covers the gap meanwhile. |

## Terminology

- **Project**: a git repository on this machine, registered by absolute
  path, plus manager-side metadata.
- **Agent**: a named, long-lived conversation in a project: a profile
  (which CLI), a cwd, a vendor conversation id, and a history of sessions.
- **Session**: one daemon session, i.e. one process. An agent's current
  session is where its turns go; earlier sessions are history.
- **Feature**: a markdown file under `features/` in the project describing
  a unit of work, with frontmatter for status and metadata.
- **Turn**: one user message and everything the agent does until it stops.
- **Item**: one normalised transcript entry (text, thinking, tool call,
  tool result, error, system note).

## Domain model

```
User      { id, name, passwordHash, createdAt }
Project   { id, name, path, defaultProfile, createdAt }
Agent     { id, projectId, name, profile, cwd, vendorConversationId | null,
            currentSessionId | null, createdAt, archivedAt | null }
AgentSession { agentId, daemonSessionId, startedAt, endedAt | null }
Feature   { projectId, slug, title, status, priority, profile?, dependsOn[] }   // derived from files, not stored
```

Agents and their sessions are stored so the manager knows which daemon
sessions belong to which agent after a restart. Everything about what
happened inside a session is rebuilt from the daemon. A relative agent
`cwd` is resolved against the project path, never against the daemon's
working directory. Deleting a project stops its agents (stdin close, then
SIGTERM, then SIGKILL, bounded) and forgets them; the repository is not
touched.

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
| `waiting-permission` | reserved for the interactive-permissions feature |
| `error` | the vendor reported an error that ended the turn (usage limit, auth, API error); the process may still be alive |
| `exited` | no live session; resumable |

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
  /** args to add to the profile for a new conversation, or to resume one */
  startArgs(opts: { resume?: string | null }): string[];
  /** the stdin line(s) for a user turn */
  turn(text: string): unknown[];
  /** the stdin line(s) to interrupt the current turn, if the vendor supports it */
  interrupt?(): unknown[];
  /** feed one daemon log record; returns state changes and transcript operations */
  ingest(record: LogRecord): { state?: AgentState; error?: string; ops?: ItemOp[]; conversationId?: string };
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
- **copilot**: ACP over stdio. `initialize`, `session/new` (or
  `session/load` to resume), `session/prompt`; `session/update`
  notifications map onto items; the prompt reply's `stopReason` ends the
  turn.
- **codex**: app-server JSON-RPC. `initialize`/`initialized`,
  `thread/start` (or `thread/resume`), `turn/start`; `item/*` and `turn/*`
  notifications map onto items; `error` notifications become `error`.
- **fake**: drives the daemon's fake agent fixture for tests and UI
  development; produces realistic items and state changes without tokens.

Adapters are pure: a log record in, items and state out. Tests feed them
recorded logs from real sessions (`test/fixtures/<vendor>/*.ndjson`) and
assert the items and state sequence.

## Transcript items

```ts
type Item =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string; streaming: boolean }
  | { kind: 'thinking'; text: string }
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
  has just reconnected); attachments live on the daemon socket, so a
  disconnect invalidates every session until it is re-attached. An exit
  that arrives for a session whose log has not been replayed yet is held
  until it has, so the boundary always follows the records.
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

All under `/api`, JSON, cookie-authenticated except `POST /api/auth/login`.

```
POST   /api/auth/login              { name, password }         -> { user }
POST   /api/auth/logout
GET    /api/auth/me

GET    /api/projects                                            -> [{ project, agentCounts: { working, idle, error, ... } }]
POST   /api/projects                { name, path, defaultProfile? }
GET    /api/projects/:id
PATCH  /api/projects/:id
DELETE /api/projects/:id            (does not touch the repository)

GET    /api/projects/:id/agents                                 -> [{ agent, status }]   status = { state, error, lastActivityAt }
POST   /api/projects/:id/agents     { name, profile, cwd? }     -> starts a session
GET    /api/agents/:id                                          -> { agent, status, sessions }
GET    /api/agents/:id/items?from=<n>                           -> { items: StoredItem[] }, n a non-negative integer index
POST   /api/agents/:id/turn         { text }                    -> 202; 409 { code: 'agent-busy' } while a turn runs; 503 { code: 'agent-unavailable' } if the session's output cannot be attached
POST   /api/agents/:id/interrupt
POST   /api/agents/:id/stop         (end input; agent becomes exited, resumable)
POST   /api/agents/:id/archive

GET    /api/profiles                                            -> daemon profiles, each with `supported` (an adapter exists)
GET    /api/health                  (public)                    -> { status: 'ok', daemon: boolean }

GET    /api/projects/:id/files?path=<dir>                       -> tree entries        (milestone 2)
GET    /api/projects/:id/file?path=<file>                       -> content, size-capped (milestone 2)
GET    /api/projects/:id/features                               -> parsed feature files (milestone 3)
POST   /api/projects/:id/features/:slug/queue                                           (milestone 3)
```

Paths for files are resolved inside the project root only; `..` is
rejected. That is a correctness rule, not a security one, on this VM.
`path.resolve` alone is not containment (symlinks escape without `..`);
the file endpoints need a real-path check before milestone two ships.

Every mutating request must be a JSON object (400 otherwise) and, when the
browser sends an `Origin` header, that origin must be the manager's own
host or `AGENT_MANAGER_PUBLIC_ORIGIN` (403 otherwise). Requests without an
`Origin` header, such as curl, pass.

### Websocket `/api/events`

Authenticated on upgrade with the same cookie. Server to client only in
milestone one; every frame has a `type`:

```
hello            { user, daemon: { connected } }   // first frame after the upgrade
daemon           { connected }                     // the manager's link to the daemon changed
project.counts   { projectId, counts }
agent.state      { agentId, projectId, status }    // status = { state, error, lastActivityAt }
agent.item       { agentId, item }                 // item = StoredItem { index, sessionId, seqFrom, seqTo, item }; same index again means an update
agent.session    { agentId, session }              // a new session started or one ended
agent.reset      { agentId }                       // the transcript was rebuilt; refetch items from 0
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
- No roles in milestone one; every user sees every project.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_MANAGER_LISTEN` | `0.0.0.0:4268` | bind address; behind haproxy for TLS |
| `AGENT_MANAGER_DAEMON_URL` | `ws://127.0.0.1:4267/` | the daemon |
| `AGENT_MANAGER_DATA_DIR` | `~/.local/state/agent-manager` | SQLite database, session secret |
| `AGENT_MANAGER_UI_DIR` | `<install>/ui` (next to `dist/`) | built UI to serve at `/`; empty string disables |
| `AGENT_MANAGER_PUBLIC_ORIGIN` | unset | e.g. `https://agents.example`; accepted by the origin check and, when https, turns on Secure cookies |
| `AGENT_MANAGER_SECURE_COOKIE` | `0` | force Secure cookies |
| `AGENT_MANAGER_LOGIN_ATTEMPTS_PER_MINUTE` | `10` | login throttle |
| `AGENT_MANAGER_TRUSTED_PROXIES` | unset | comma-separated proxy addresses whose `X-Forwarded-For` gives the client address; set it behind HAProxy or every user shares one throttle |
| `AGENT_MANAGER_ADMIN_PASSWORD` | unset | creates the first admin on first start |

The built UI's static assets and the SPA fallback are served without
authentication: the login page must load. Everything under `/api` except
login and health requires the cookie.

## Testing

- Unit: adapters against recorded logs; state machine; feature file
  parsing; path resolution.
- End-to-end: a real daemon on an ephemeral port (from the agent-daemon
  repo's build, or `npx` of it) with the fake profile, the manager on an
  ephemeral port, supertest for REST and `ws` for events. Covers login,
  project and agent lifecycle, turns and items through the fake agent,
  manager restart with state rebuilt from the daemon.
- Opt-in smoke: one real Claude turn through manager and daemon.

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
2. **Files**: tree and file endpoints; UI file browser with Monaco,
   read-only.
3. **Features**: `features/*.md` convention, parsing, listing, queueing a
   feature as a turn for a chosen agent, manager-owned status updates.
4. Later, each needing its own discussion: git status and diff per agent;
   worktrees and multi-agent coordination; interactive permissions;
   idle timeout and automatic resume; Codex and Copilot adapters (the
   interface is designed for them; milestone one ships Claude and fake);
   clone-from-URL; roles; log retention.

## Open questions

- Whether `waiting-input` is derivable for Claude at all, or whether "idle
  after a turn whose last text ends in a question" is as good as it gets.
- Streaming granularity for `agent.item`: per delta, or coalesced on a
  short timer to spare the UI.
