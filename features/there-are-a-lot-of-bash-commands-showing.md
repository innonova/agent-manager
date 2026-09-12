---
title: there are a lot of bash commands showing
status: review
priority: 100
---

a lot of the shown bash commands are essentially just read file or other basics maybe the could be reduced to the description (from the json) in the chat and allow unfolding like with the result now but just one line that then shows both command and and result

## Report (2026-09-12)

A tool call and its result are now one collapsed line: the tool name,
what the call is for, and on the right the result's size, "error" in
red, or a pulsing "running…" until the result arrives. The description
comes from Claude's Bash `description` field when present; file tools
show their path, search tools their pattern, other shells the command
itself, and anything else a compact input. Unfolding shows the command
as plain text (or the input as JSON) and the result beneath it, so one
click shows both. The pairing is by tool id in the transcript view; a
result whose call is not in the transcript still renders on its own.

Verified by the UI test that opens a call and checks the input and
result appear. One side fix: the e2e backend now raises the manager's
login throttle, which the growing suite had started to hit. Left open:
nothing.
