---
title: favicon
status: review
priority: 100
---

create a bespoke favicon

## Response (2026-09-12)

test response, what is the purpose of respond and close? also these entry fields have the same lost input if switching away issue that the main input had

## Report (2026-09-12)

The favicon itself was done in the first pass (see the earlier
summary: `public/favicon.svg` is the source, the ICO and touch icon are
rendered by `scripts/favicon.mjs`). This pass answers the response.

**"Respond and close"**: it appended your note and set `done` in one
step, for closing with a recorded reason. That is thin next to "done"
on the row, so it is gone. The box now has one button, "respond", which
appends the note and sets `planned`; "done" on the row closes.

**Lost input**: the response box and the new-feature form now keep
their text in the same drafts store as the turn input, per feature and
per project respectively, so switching tab, closing the dialog or
reloading keeps what you typed. Cleared when sent or created.

Verified by the UI suite (nine tests, including tab switches around
both fields). Left open: nothing.
