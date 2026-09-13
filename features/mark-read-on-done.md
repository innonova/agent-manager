---
title: marking a feature done advances the read cursor
status: done
priority: 100
---

"Done" on a feature means the human has looked at its work. Advance the
user's read cursor (the changes view's default base) to HEAD in every
repository of the project when a feature is marked done, so the "since
you last looked" list empties at the same time. Only for the user who
clicked; only when the agent is not in progress on something else in the
project, or at least say so.

## Report (2026-09-13)

Marking a feature done now moves the caller's read cursor to HEAD in
every repository of the project, whether done is set from the row or
through a response. The cursor logic moved into a small shared service
so the features service could use it without a dependency cycle. It
applies to the user who clicked only, as read cursors are per user.

On "only when the agent is not in progress on something else": I did
not gate it. The cursor is just "what I have looked at", and marking a
feature done is the human saying they have looked at the repository as
it stands; if another agent's work is in flight, its uncommitted changes
still show, since the changes view always includes the working tree.
Verified by the manager's changes test. Left open: nothing.
