---
title: bounded transcript history
status: blocked
priority: 20
dependsOn: [lifecycle-tests-scripted-daemon]
---

Not yet: needs a design discussion first (blocked until then).

Every agent's normalised transcript stays in memory and is rebuilt from
the daemon on every restart, archived agents included. Fine for weeks,
bad for months; the failure mode is a restart that cannot complete.
Page transcripts, load archived ones on demand, keep the daemon log as
the source of truth it already is, and keep item indexes stable for
clients. Decide first: what stays resident (the current session's
items? the last N?), what the API looks like for older items, and how a
rebuild after restart avoids reading every log in full.
