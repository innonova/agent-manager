---
title: editing a feature's spec while in review
status: done
priority: 100
---

The edit dialog is offered for planned features only. A feature in review
(or blocked) sometimes needs its spec touched before it is sent back, and
today that means reopening it just to edit. Offer "edit" for review and
blocked as well; keep it off for in-progress, since the agent may be
writing the file.

## Report (2026-09-13)

"Edit" is now offered on every feature that is not in progress: planned,
review, blocked and done. Only in-progress is left out, since the agent
may be writing the file. One-line change in the features view plus the
design doc. Verified by the existing UI suite. Left open: nothing.
