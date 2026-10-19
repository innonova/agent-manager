---
title: an agent of a project here can run on another machine
status: in-progress
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
