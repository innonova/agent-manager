---
title: adding new features while a feature run is ongoing
status: done
priority: 100
---

do we need some way to manage features being added during a feature run?

## Report (2026-09-12)

Not as a mechanism, no. Since nothing queues features any more there is
no "run" the manager could guard: a batch is just a human asking an
agent to work through what is planned, and a feature added meanwhile is
a file the agent has not read yet. Two things cover it:

- the convention now says that an agent asked to work through the
  planned features re-reads `features/` before it finishes and takes up
  anything planned that appeared meanwhile, so a batch drains rather
  than stops at the list it started with (added to each repository's
  `CLAUDE.md` and to the manager's design doc);
- the features tab shows a new file within seconds, so you can always
  tell the agent about it directly, with a caveat if it should wait.

Nothing was built for this beyond the two sentences of convention.
Left open: whether "one agent at a time per repository" needs stating
for batches on several agents; today that is already in the agent
instructions ("one writing agent per repository").
