---
title: the dialog handed back after a compaction
status: in-progress
priority: 5
dependsOn: []
---

## Purpose

An agent that runs for weeks has its context replaced by a summary of
itself again and again, and what the person and the agent settled
together does not survive that. Measured on this project's own agent
(2026-11-15, learnings #233): asked fifteen questions about intents,
reasons, decisions and open offers from one stretch of work, the agent
with its full context answered all of them; after the compaction that
followed, nearly all; one real compaction later 18 of 30 points; two
later, 13. The person's own messages came through every time, because
Claude Code's summary quotes them. What went was the agent's side: its
reasons, the caveats it gave, the offers the person never answered,
and whether a reading of the person's words had been confirmed. An
inference marked "mine, unconfirmed" was stated as fact one compaction
later.

That side counts as much as the person's. This is how the two work:
the person writes a few thoughts, the agent answers with its reasoning
and proposals, and the person reads the answer and objects to what
they disagree with. An answer that was read and not disputed is
agreed, every sentence of it. A summariser cannot know which sentences
those were, so it must not paraphrase any of them.

The dialog is small: both sides together are 2 to 7% of a context
window, measured over 32 windows of five sessions. In the test above,
handing the dialog of the last three hours back word for word, 4.8K
tokens, took the score two compactions later from 13 to 28.

A good result, seen from the agent's chair: after a compaction it
still has, word for word, what was said recently and what was said
long ago and still governs the work, it knows that the rest exists and
can fetch any of it, and none of that depended on what the summary
happened to keep. Seen from the person's chair: nothing they settled
has to be settled again because the agent's context turned over.

## How it works, as decided in the conversation (2026-11-15)

These are requirements; the reasoning stands beside each because the
details will be tuned.

- **The dialog is both sides, word for word, in exchanges.** An
  exchange is what the person wrote and what the agent wrote back
  until the person wrote again. The manager already holds it: the
  transcript's messages and the agent's text, and the chat. Nothing in
  it is ever paraphrased on the way back to the agent; an exchange is
  handed back whole or not at all. The agent's short progress lines
  between tool calls are not dialog and are left out.
- **After every compaction the manager hands back three things.** The
  most recent exchanges, up to a budget. Older exchanges that still
  matter, chosen by a classifier, wherever they sit: the conversation
  that founded the project counts here, and no rule singles out "the
  start" by position (in the two sessions tried, the classifier gave
  the founding exchanges top weight without one). And one index line
  for every other exchange, so the agent knows it exists.
- **The agent can fetch any exchange by its number** (`am recall`), so
  nothing left out is lost, only one step away.
- **A model weighs the older exchanges, judging each with knowledge of
  what came later.** It reads the whole dialog in one call and gives
  each exchange a kind (purpose, rule, decision, task, chatter), a
  weight from 0 to 3 (3: without it the agent would act against
  something settled, or reopen an argument already had), whether it is
  still in force, and the index line. It selects; it writes nothing
  the agent will read as dialog. Tried on this project's 273
  exchanges: Sonnet 5.5's top list reads like the project's settled
  design; Haiku 5.5 gave top weight to four exchanges and rated
  several essential ones 0 or 1, so it is not good enough to select
  by. Which model does it is a setting, because the person expects a
  stronger one to be cheaper than the failures it prevents, and that
  is to be tried.
- **The budget is a share of the agent's context window**, a tenth by
  default: for a 1M window about 100K tokens, half of it for the
  recent exchanges.
- **It is the manager's doing, outside the agent's context**, so it
  does not depend on what the summary kept, and it is the same after
  the tenth compaction as after the first.

## Must not

- Paraphrase, trim or merge what either side wrote. Selection only.
- Hand back an exchange that a take-back removed from the agent's
  memory.
- Present an exchange that was later reversed as if it stood: the
  exchanges go back in the order they happened, with their dates, so
  the later one reads as the later one, and one the classifier marks
  superseded goes back as an index line that says so, not in full.
- Stop or delay the agent for long: a compaction has already cost it
  two minutes.
- Spend a model's tokens without it being visible that the manager
  did, and on what.

## Facts and pointers

- Claude Code runs a `SessionStart` hook with source `compact` after a
  compaction, also in the headless sessions the manager runs (checked
  2026-11-15 with `claude -p`), and adds its output to the agent's
  context. The output is capped at 10,000 characters; beyond that the
  agent gets a file path and a preview. So the hook's text is a short
  notice that names files, and the dialog is in the files. In the
  check a Haiku agent read the files of its own accord at its next
  turn and acted on what only they held.
- The manager already gives Claude sessions a settings file with a
  hook of its own (`claudeSettingsFile`, the clock and the chat
  notice), for agents on the manager's own machine only.
- Editing a record in the middle of Claude's conversation file makes
  the API drop every later thinking block, and a message from the
  manager would read as the person's and be quoted as theirs by the
  next summary. Hence a hook and files, not a rewrite and not a
  message.
- The Claude adapter reports a compaction: the `compacting` activity
  while it runs, a `system` item when it is done, and the context
  window's use and size (`usage.context`).
- The experiment's scripts and results: `/tmp/compaction-lab` on the
  dev box (`classify-system.md` is the classifier's prompt as tried).

## Suggestions, open to challenge

- Classify ahead of the compaction, when the context passes a share of
  the window, so the result is there when the hook asks; at the
  compaction itself only if nothing recent exists, and then the hook
  waits a bounded time and otherwise goes with the weights it has.
- Run the classifier as a child process of the manager (`claude -p`
  with no tools and its own system prompt), configurable as a whole
  command so a test can replace it and another vendor's CLI can be
  tried.
- Number exchanges by their order in the agent's history, so a number
  means the same thing after any number of compactions.

## Hard to verify, and how

- That the hook fires in a session the daemon holds (stream-json, a
  compaction in the middle of a turn) and the agent reads the files:
  a real Claude agent in a separate instance, compacted with
  `/compact`, then asked for something only the files hold.
- That the selection is good: there is no test for that but reading
  it. The index and the weights are served so a person can.

## Not in the first round

- Codex and Copilot: they have no such hook. The record, the weights
  and `am recall` work for them; the handing back does not.
- Agents on another machine (the settings file and the hook are on the
  manager's disk today).
- A view of the record and its weights in the UI; a way for the person
  to pin or unpin an exchange.
- A second pass that checks the top-weight exchanges for reversals.
- Decisions the agent took alone in a long stretch without the person:
  they are dialog only once they are in a reply or in the chat.
- Steering what Claude Code's own summary spends its length on, now
  that the dialog no longer depends on it.

## Worth

A day or two. The alternative is what happens today: the person
re-explains, or does not notice that they need to.
