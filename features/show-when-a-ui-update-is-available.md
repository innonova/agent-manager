---
title: show when a ui update is available
status: review
priority: 100
---

show a badge somwhere in the top bar that can be clicked to refresh

## Report (2026-09-12)

Every UI build now carries an id (the build time), baked into the
bundle and written next to it as `build.json`. The page fetches that
file when the events socket reconnects (a deploy restarts the manager,
so this is the moment a new build appears), when the tab becomes
visible, and every ten minutes. A different id shows a blue "update
available · reload" button in the top bar; clicking it reloads.
Nothing reloads by itself, since a draft or a scroll position may be in
play.

Verified by a UI test that serves a different id and triggers the
visibility check. Left open: nothing.
