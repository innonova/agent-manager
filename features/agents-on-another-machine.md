---
title: an agent of a project here can run on another machine
status: review
priority: 2
dependsOn: []
---

## Purpose

A project is the thing with a purpose: features, a run log, a changes
view, learnings. It lives on the hub with its repositories. A second
machine, a Windows VM say, is a capability: a desktop, a toolchain, an
operating system to verify on. Nothing of lasting value is born there.
Today the only way to run an agent on a spoke is a project on the spoke,
which forces one to invent a project just to have somewhere to put the
agent, and splits the project's features and runs across machines.

The point is that agents have a host and projects do not: an agent of a
project here can be started on another machine, with a working directory
there (usually a checkout of the same repository the agent keeps in
sync itself), and everything else about it, the transcript, the run
log, the features it reports on, stays here.

## Requirements

- An agent record has a `host` (null for this machine). Creating an
  agent takes `host` and, for a remote one, an absolute path on that
  host as `cwd`; the project's repository check does not apply there.
- The hub drives the agent's session on the host's daemon directly:
  adapters, transcript, runs, features all run on the hub, as for a
  local agent. The spoke's manager only lends its daemon: a websocket
  tunnel to it, authenticated with the hub token.
- A remote agent's `am` reaches the hub: its `AGENT_MANAGER_URL` is an
  address the host can reach (`AGENT_MANAGER_AGENT_URL`, default the
  manager's own listening address).
- The harness note tells a remote agent where it runs, that the
  project's repositories live on the hub, and what its own directory is.
- The UI's new-agent form takes a host when there are several, with a
  path field for a remote one and the profiles of that host; the agent
  header shows the host. `am new` takes `--host`.
- The hub's `hosts` status says whether each host's daemon is reachable
  through the tunnel.
- The project-on-a-spoke model stays as it is; nothing new builds on it.

## Facts

- `src/daemon/daemon-client.ts` is one injectable client of one daemon
  (`config.daemonUrl`); `AgentsService` uses it in 25 places (start,
  input, signal, attach, listSessions, getSession, remove, endInput,
  `connected`, four event subscriptions). Session ids are UUIDs the
  daemon makes, unique across daemons.
- The spokes are read by `loadSpokes()` in `src/hub/hub.service.ts`
  from `spokes.json` (name, url, token); the hub calls a spoke with
  `Authorization: Bearer <token>` and `x-acting-user`.
  `AuthService.userForHeaders` accepts the hub token.
- `EventsGateway` is a `@WebSocketGateway` on `/api/events` under the
  platform-ws adapter; a second gateway on another path is the same shape.
- `extraDirs()` passes the project's other repositories to the CLI; for
  a remote agent none of them exist on its host.
- The commit attribution resolves HEAD in the commit's cwd on the hub's
  disk; a remote agent's commits are logged and dropped there, by design
  of that feature.
- The hub's forwarding of `/api/projects/:id` and `/api/agents/:id` by
  prefixed id is untouched: a remote agent of a hub project has a plain
  hub id.
- The Windows spoke (host `win`, 192.168.1.166) runs the daemon and
  manager as scheduled tasks in the console session; `claude` is logged
  in there. `playground` there is the project this feature makes
  unnecessary.

## Suggestions

A `DaemonClients` service holding the local client and one per spoke
(from the same `spokes.json`), re-emitting their events with the host;
`AgentsService` asks it for the agent's client. The tunnel: a gateway on
`/api/daemon` that checks the hub token, opens a socket to the local
daemon and pipes frames both ways. The hub e2e (two managers, two
daemons) can create an agent of a hub project on host `vibe` with the
spoke daemon's fake profile and see its transcript on the hub.

## Report (2026-10-19)

Gated alone (manager unit 123, lint clean, e2e 131 with a new hub case;
UI 25; CLI 8). Deployed: hub reinstalled with
`AGENT_MANAGER_AGENT_URL=http://192.168.80.81:4268`, the UI and `am`
swapped in, the spoke's manager rebuilt from the new tree.

**Changed.** `DaemonClient` is a plain class, one per daemon, opened
with a URL and headers; `DaemonClients` holds the hub's own and one per
`spokes.json` entry (the loader moved to `src/hub/spokes.ts`) and
re-emits their events with the host. `DaemonTunnelGateway` on
`/api/daemon` accepts the hub token and pipes frames to the local
daemon. The agents service asks for the client by the agent's `host`
(new column, `Live.host`); a daemon's loss gates only its agents, the
watchdog skips agents whose daemon is away, a resync reads each agent's
own daemon. `POST .../agents` takes `host` (must be a configured spoke;
`cwd` then an absolute path there, Windows or POSIX, unchecked against
the repositories); a remote agent gets no `--add-dir`, its
`AGENT_MANAGER_URL` is `AGENT_MANAGER_AGENT_URL`, and its note says
which machine it runs on and that the repositories are on the hub.
`GET /api/profiles?host=` lists a spoke's daemon profiles. The hosts
status reports the hub's tunnel to each daemon. UI: a Machine select in
the new-agent form when there are several hosts, a path field and the
host's profiles for a remote one, a host chip in the agent details.
CLI: `am new --host H --cwd PATH`. Installer: `agent-url.conf` drop-in.
Docs: the manager's Hub and spokes section, the API lines, the env
table; the UI's hub section; the README.

**Verified.** The hub e2e: an agent of a hub project on host `vibe`
with the spoke daemon's fake profile; 400 for an unknown host and a
relative path; the session listed on the spoke's daemon and not the
hub's; the note's wording; a turn answered through the tunnel; the
hosts picture. Then for real: `win-scout`, an agent of agent-system on
`win`, took a screenshot of the VM's desktop from console session 2 and
reported `AGENT_MANAGER_URL` as the hub's LAN address. The spoke-owned
`playground` project is deleted.

**Left open.** `am` is not installed on the VM, so a remote agent's
`am hold`/`am learn` do not work yet; the CLI's Windows install is a
small follow-up. A remote agent cannot edit a feature file (the file is
on the hub): the starting agent writes the report from its answer, or a
report route comes later. The files and changes views stay the
project's; a remote agent's own tree is not browsable. The spoke-owned
project model is still there; nothing new is built on it. Auto-logon on
the VM is the person's call.

**Noticed, left alone.** The hub's tunnel client logs "socket hang up"
every backoff while a spoke runs an older manager; harmless, and gone
once the spoke is updated. Session ids are the daemons' UUIDs; two
daemons colliding is not handled, by the odds.
