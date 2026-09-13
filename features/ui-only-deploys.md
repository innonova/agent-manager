---
title: UI-only deploys without restarting the manager
status: review
priority: 100
---

A UI change is deployed through `npm run install:service` in the manager,
which rebuilds and restarts the manager. Restarts are harmless to agents
and the update badge softens them, but a restart per CSS tweak is silly.
Give the UI its own deploy step that swaps the static directory the
manager serves, without touching the manager process. Document it in both
READMEs and the UI's CLAUDE.md (Finishing work).

## Report (2026-09-13)

`npm run install:ui` in the manager copies `../agent-manager-ui/dist`
next to the served directory and swaps it in with two renames; Express
reads files per request, so the new build is live at once and the
manager process is untouched. Open tabs offer a reload when they next
check `build.json` (on reconnect, on focus, and every minute). `install:service` remains the deploy for manager changes and
still carries the UI along. Documented in both READMEs and both
CLAUDE.md files; the UI's finishing-work rule now names `install:ui`.
Verified live: the manager's pid was the same before and after the
swap. Left open: nothing.
