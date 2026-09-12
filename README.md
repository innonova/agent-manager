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
