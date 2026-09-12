---
title: padfing in main agent text box
status: done
priority: 100
---

when typing in the main agent text box as more lines start to build the currently typed line is exactly on the bottom edge which is a little awkward, scrolling technically fixes it but that isn't a natural action

## Report (2026-09-12)

The box now grows with its content: on every change its height is set
to fit the text, from the two-row minimum up to a maximum of about
twelve lines, after which it scrolls. The line being typed therefore
never sits on the bottom edge; the box just gets taller. The maximum
keeps the transcript visible when pasting something long.

Verified by the UI suite: the drafts test fills five lines and checks
the box is taller than with two. Left open: nothing.
