# agent-manager

The layer between the browser UI and `agent-daemon`: projects, agents,
users, and the knowledge of what the agent CLIs are saying. Exposes an
authenticated REST and websocket API and serves the built UI.

- Design, API and models: [docs/design.md](docs/design.md)
- The daemon it drives: `../agent-daemon`
- The UI it serves: `../agent-manager-ui`

Installing the whole setup from scratch: `../agent-daemon/docs/install.md`.

## Quickstart

```
npm install
AGENT_MANAGER_ADMIN_PASSWORD=... npm run install:service   # build, install, start the user service on :4268
npm run user:add -- alice                                  # more users
journalctl --user -u agent-manager -f
```

The install also writes a `fake` profile into the daemon's profile
directory and reloads it, so agents can be tried without spending tokens.
Restarting the manager never affects running agents; they live in the
daemon and are re-adopted on start.

## Deploying

`npm run install:service` is the only deploy step, for manager and UI
changes alike:

1. builds the manager from this checkout;
2. copies `dist/`, `fixtures/` and the package files to
   `~/.local/lib/agent-manager` and installs production dependencies there;
3. copies `../agent-manager-ui/dist` to `~/.local/lib/agent-manager/ui` if
   it exists (build the UI first, or a stale UI ships silently; without a
   build the manager runs API-only);
4. writes the daemon's `fake` profile and reloads the daemon's profiles
   (a reload, not a restart: running sessions are untouched);
5. rewrites the unit file and restarts the manager service.

For a change to the UI only, skip all that: `npm run build` in
`../agent-manager-ui`, then `npm run install:ui` here. It swaps the served
directory in place and does not restart the manager; open tabs offer a
reload when they next check for a new build.

It leaves the database and `proxy.conf` under
`~/.config/systemd/user/agent-manager.service.d/` alone; it rewrites
`admin.conf` there when `AGENT_MANAGER_ADMIN_PASSWORD` is set (the
password in the clear, mode 600). That variable creates `admin` on the
first start only, when no user exists; an existing password is reset
from the Users page, not by reinstalling. The unit `Wants=` the daemon's,
so starting the manager starts the daemon if it is not running.
Restarting the manager is a non-event for agents.

## Several machines, one UI (hub and spokes)

Every machine runs its own daemon and manager. To see and drive them all
from one UI, make one manager the hub:

1. On each other machine (a spoke), install the manager with a token:
   `AGENT_MANAGER_HUB_TOKEN='<long random string>' npm run install:service`
   (kept in the `hub.conf` drop-in, mode 600). Its port must be
   reachable from the hub.
2. On the hub, write `~/.local/state/agent-manager/spokes.json`:
   `[{ "name": "vibe", "url": "http://192.168.1.20:4268", "token": "<the same string>" }]`,
   `chmod 600` it (it is ignored otherwise: the tokens are credentials),
   and restart the manager (`systemctl --user restart agent-manager`).
   `AGENT_MANAGER_HOST_NAME` on either side names the machine (kept in
   the `host.conf` drop-in by the installer); a spoke must not share the
   hub's name.

The hub's project list then shows every machine's projects with the
machine's name; agents are driven through the hub as the logged-in user,
who is created on the spoke by name. `docs/design.md` (Hub and spokes)
has the details and the limits.

## Development

```
npm run start:dev     # against the running daemon on 127.0.0.1:4267
npm test              # unit tests, including adapters against recorded logs
npm run test:e2e      # needs ../agent-daemon built (npm run build there)
```

## Behind a reverse proxy (TLS)

The manager speaks plain HTTP and expects a TLS terminator in front. Two
things must be configured or the cookie and the login throttle misbehave:

```
# ~/.config/systemd/user/agent-manager.service.d/proxy.conf
[Service]
Environment=AGENT_MANAGER_PUBLIC_ORIGIN=https://aman.example
Environment=AGENT_MANAGER_TRUSTED_PROXIES=192.168.80.89,192.168.190.1
```

- `AGENT_MANAGER_PUBLIC_ORIGIN` is the origin browsers use. It turns on the
  Secure cookie flag and is accepted by the same-origin check for
  mutations and the websocket.
- `AGENT_MANAGER_TRUSTED_PROXIES` lists every hop that appends to
  `X-Forwarded-For`, as the manager sees them (the direct peer and any
  proxy behind the TLS terminator). The rightmost untrusted address is the
  client, which the login throttle keys on; with no trusted proxies every
  user shares the terminator's address and one attacker locks everyone out.
  The TLS terminator must add the client address (`option forwardfor` in
  HAProxy).

The install script leaves drop-in files alone, so the setting survives
reinstalls. `deploy/nginx-proxy.conf.example` is a working nginx site for
the middle hop, including the websocket upgrade for `/api/events` and a
long read timeout for it; HAProxy needs a `timeout tunnel` of similar
length so the event stream is not cut. Add HSTS at the TLS terminator.
The manager's own bind (`AGENT_MANAGER_LISTEN`) should not be reachable
from the internet; only the proxy chain should be.
