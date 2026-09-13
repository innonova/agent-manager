---
title: which model is being used
status: review
priority: 100
---

show which model is active, allow chosing model and likewise for context window size and thinking effort

## Report (2026-09-13)

Shown: the agent header has a chip with the model the vendor reports as
active in the current session, taken from Claude's `init` line, Codex's
`thread/started` and Copilot's config options; it clears when the
session exits. Chosen: the new-agent form takes a model name and an
effort level (low, medium, high, xhigh, max), both optional and passed
to the vendor as is at session start: Claude and Copilot get
`--model`/`--effort`, Codex gets `-c model=` and `-c
model_reasoning_effort=`. The manager does not validate the names
beyond shape; a bad one is rejected by the vendor when the session
starts and shows as an error there.

Context window: not a separate control. For Claude the context size is
part of the model name (the `[1m]` variants), so it is chosen through
the model field; Codex and Copilot expose no such switch on their
command lines. Changing model or effort on an existing agent is not
offered: they apply at session start, so it would take effect only on
the next session; create a new agent instead. Verified by adapter tests
for the start arguments and model reporting, a manager test with the
fake agent, and the UI test that creates an agent with a model and sees
the chip. Left open: a per-vendor list of valid model names, which
would need a source of truth the CLIs do not offer.
