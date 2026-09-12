---
title: UI-only deploys without restarting the manager
status: planned
priority: 100
---

A UI change is deployed through `npm run install:service` in the manager,
which rebuilds and restarts the manager. Restarts are harmless to agents
and the update badge softens them, but a restart per CSS tweak is silly.
Give the UI its own deploy step that swaps the static directory the
manager serves, without touching the manager process. Document it in both
READMEs and the UI's CLAUDE.md (Finishing work).
