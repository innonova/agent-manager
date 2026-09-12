---
title: notifications
status: done
priority: 100
---

use browser notifications to let the user know when an agent needs input or simply is ready for more input

## Report (2026-09-12)

Browser notifications, opt-in per browser: the settings menu has a
"Desktop notifications" checkbox; turning it on asks the browser for
permission from that click (the only place browsers allow the ask) and
stays off if refused, with a hint when the site is blocked. Once on, a
notification appears when an agent finishes working ("<name> is ready
for more"), needs input or a permission ("needs your input"), or fails,
but only while the page is not in front, since someone looking at it
sees the state badge change. One notification per agent at a time;
clicking it brings the window up on that agent.

Verified by a UI test that stubs the browser's Notification object,
unfocuses the page, opts in, sends a turn to the fake agent and checks
one "ready for more" notification, then that the setting survives a
reload. Left open: a badge on the tab title or favicon for the same
signal when the tab is visible but not looked at; and whether
"waiting-input" fires for real agents, which depends on the adapters.
