# agent-manager

The layer between the browser UI and `agent-daemon`: projects, agents,
users, and the knowledge of what the agent CLIs are saying. Exposes an
authenticated REST and websocket API and serves the built UI.

- Design, API and models: [docs/design.md](docs/design.md)
- The daemon it drives: `../agent-daemon`
- The UI it serves: `../agent-manager-ui`

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
