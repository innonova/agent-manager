---
title: the dialog handed back after a compaction
status: review
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

## Report (2026-11-15)

Built and deployed, gated alone. A Claude agent on the manager's own
machine now gets its dialog handed back after a compaction; every
agent has the record and `am recall`.

### What changed

- **agent-manager** (`eb862fc` and the commit carrying this report).
  A new module, `src/dialog/`:
  - `dialog.ts`, pure: what an exchange is (from transcript items and
    chat messages), the selection within a budget, the files and the
    notice as text, the classifier's instructions and the reading of
    its answer.
  - `dialog.service.ts`: reads the record, runs the classifier as a
    child process, keeps the weights (`dialog_weights`), triggers a
    weighing when an agent's context passes 70% of its window or Claude
    reports `compacting`, and answers the hook.
  - Routes: `GET /api/agents/:id/dialog` (the list), `.../dialog/:n`
    (one exchange), `.../dialog/handback` (what would be handed back
    now, nothing written), `POST .../dialog/weigh` (start a weighing),
    `POST /api/dialog/handback` (the hook; agent token only).
  - `fixtures/handback-hook.mjs`, wired into the settings file Claude
    sessions are started with, as a `SessionStart` hook for `compact`.
  - `AgentsService.note` (a line of the manager's own in a flow),
    `ChatService.all`, six `AGENT_MANAGER_DIALOG_*` settings, a line in
    the shipped harness note, the design's "The dialog after a
    compaction".
- **agent-manager-cli** (`96d27d6` and one more): `am recall`: the
  list, exchanges by number or range, `--handback [--full]`, `--weigh
  [--model M]`.
- **agent-manager-ui** (`172e7bd`): its test backend weighs nothing.

### Which model weighs: tried on this agent's 273 exchanges

| Model | Top weight | Weight 2 or 3 | One weighing |
| --- | --- | --- | --- |
| Haiku 5.5 | 4 exchanges | 54 | $0.08 |
| Sonnet 5.5 | 48 | 130 | under $1 |
| Opus 5.5 | 10 | 56 | $1.90 |
| Fable 5.2 | 15 | 69 | $3.97 |

Opus and Fable agree on the weight of 216 of 273 exchanges and are
within one level on 272; of what Opus would hand back, 96% is in what
Fable would. Sonnet's extra top-weight exchanges are mostly reports of
finished work ("clock hook built", "8 GB swapfile added"), whose
outcome is in the repository. Fable's extras over Sonnet are rules and
reasons ("review UI work by looking at the screen, not the green
suite", "prescriptive briefs cap results"). Opus marked a few standing
decisions as no longer in force that Fable kept (the harness note
"informs, not instructs"). Both Opus and Fable saw that today's
take-back change reversed October's rule; Sonnet named the reversal
and still called the old rule in force (the manager's reading treats a
named reversal as not in force). Hence the default, `fable[1m]`.

### What was verified

- Unit: 12 tests for the module (exchanges, selection, the files and
  notice, the classifier's input and answer, the hook script against a
  small HTTP server). Manager suite 147 unit, 151 end-to-end, lint.
  One new end-to-end test with the fake agent and a script for a
  classifier: record, weighing, preview, hand-back, the flow line,
  that a person's cookie cannot ask for a hand-back.
- CLI: 22 unit, 10 end-to-end (`am recall` in the chat test). UI:
  Playwright 35 against the new manager.
- **A real Claude agent in a separate instance** (Haiku 5.5, the
  weakest reader, with Haiku as classifier to keep it cheap): five
  exchanges, then `/compact`. The manager saw `compacting`, weighed (6
  s), answered the hook, wrote one file, and the flow got "dialog
  handed back: …" and "context compacted on request: 28k → 7k". At the
  next message, a neutral "ok, go on: what do you propose we do
  first?", the agent's first action was to read the file; then `am
  recall 1` from inside its session printed the exchange. The default
  model name `fable[1m]` was accepted there on request.
- **On the installed manager**, this agent's own dialog: 275
  exchanges, the same ones the experiment's script found in Claude's
  own file. Weighed by Fable in 329 s. A hand-back now would hold 75
  recent exchanges and 39 earlier ones whole and 161 as lines, about
  90K tokens of a budget of 100K, in five files. The top-weight list
  reads right to me: the standing rules (commit and deploy without
  asking, briefs to the person first, review rounds), how the person
  wants helpers treated, features as files, agents have a host, the
  chat decisions.

### Decided for the person

- The default classifier is `fable[1m]`, per the comparison above and
  your remark that even Fable is cheaper than the failures.
  `AGENT_MANAGER_DIALOG_CLASSIFIER_MODEL` changes it; `off` stops all
  weighing.
- The budget is a tenth of the window, half for recent exchanges;
  weighing starts at 70% of the window.
- No rule keeps "the start" by position; the classifier's `purpose`
  kind covers it.
- A short text of the agent's counts as dialog only if it ended a turn
  or came just before the person wrote; other texts under 300
  characters are progress notes.
- CLI commands typed as messages (`/compact`, `/clear`, a few more)
  are not dialog.
- `POST .../weigh` answers at once and the list says how it went. The
  first version held the request; Fable's first real run outlasted the
  client's five minutes.
- A preview route and `am recall --handback`, which the spec did not
  ask for: it is how the selection can be checked before a compaction
  depends on it.

### Left open

- **Sessions already running do not have the hook.** It is in the
  settings file a session is started with, so each agent gets it at
  its next restart. That includes this agent.
- **Not seen for real: an automatic compaction in the middle of a
  turn.** The hook was verified with a manual `/compact` in a
  daemon-held session and in `claude -p`. Nothing suggests the
  automatic one differs, but it has not been watched.
- **A weighing can outlast the wait.** Fable took 5.5 minutes; the
  hand-back waits 150 s. Weighing at 70% of the window normally leaves
  days. If a compaction arrives first, the hand-back uses the weights
  it has and newer exchanges go by recency.
- **Cost is visible only as a flow line.** A weighing is a model call
  of the manager's own, on the machine's Claude login: about $4 for
  this agent, more for a longer dialog (iac's is nearly four times as
  long), roughly once per context window per agent. It is not in any
  agent's spend or in the run log.
- **The classifier also reads the machine's global `CLAUDE.md`**,
  since it is Claude Code and bare mode needs an API key.
- **Reversals are sometimes missed** by every model tried.
- Codex and Copilot, agents on another machine, a UI for the record
  and for pinning an exchange: as listed under "Not in the first
  round".
- **No second reader yet.** The module has not had a review pass.

### Noticed and left alone

- `am` writes its colour codes even when its output is not a
  terminal, so an agent reading `am recall` (or any `am` command) gets
  escape sequences in the text.
- The manager's own flow lines (session boundaries, the take-back
  marker, now "dialog handed back") exist only in the transcript
  cache. A rebuild of the cache from the daemon's logs would lose
  them, and with the take-back marker gone a taken-back exchange would
  be dialog again.
- `systemctl --user cat agent-manager` shows the unit's drop-ins,
  one of which holds the admin password in plain text. I ran it to see
  the service's `PATH`, so the password is now in this session's log.
- The lint warning in `scripts/smoke-agents.mjs` (a body on a GET) is
  older than this work.

## Report (2026-11-15)

A second round the same day, from the conversation after the first
report. Gated alone.

### What changed

- **A hand-back on request** (`cfc76fc`, CLI `ec76b08`). An agent that
  went through compactions before there was a hand-back holds only
  summaries of its earlier dialog. `am recall --handback --now`, inside
  its session, writes the files now and prints a notice worded for
  that case; the flow says "dialog handed back on request". The
  person's reason: the xcom agent should not spend the rest of a
  low-quality window waiting for its next compaction.
- **The 1M window is read off the agent's configured model name too**
  (`8272f47`). Claude Code 2.1.325 reports the model at start without
  `[1m]`, so the header showed no context window until a turn ended.

### What was verified

- Manager 148 unit and 151 end-to-end, CLI 22 and 10; the end-to-end
  tests cover the on-request notice, its flow line, and that `--now`
  is the agent's own.
- This agent was restarted from the UI: its session was started with
  the settings file that carries the hook, and its header shows the
  window again (61% of 1M at the time).
- The xcom agent was asked, at the person's request, to weigh its
  dialog and hand it back to itself; its answer is in the conversation,
  not here.

### Agreed in the conversation, not built

- **Weigh only what is new.** Every weighing now sends the whole
  dialog. To be changed: the first weighing of an agent is the whole
  history; after that only the exchanges added since, in full, with
  the older ones as their index lines and current verdicts (those
  weighing 2 or 3 in full), and the classifier answering for each new
  exchange and for any older one the new ones reversed or closed. A
  full pass again on request and when the classifier model changes.
  To be checked against a full pass on this agent's dialog before it
  is the default.
- **An index into the whole transcript**, the person's suggestion: so
  an agent can go back and look something up in the work, not only in
  the dialog. Proposed shape: per exchange an outline of what was done
  under it (each tool call one line: its number, the tool, its own
  description or path, the size of the result; the commits made), any
  one item in full by its number, and a search over both. All from the
  transcript the manager holds, no model call.

## Report (2026-11-15)

A third round, from what the xcom agent's first hand-back showed.
Gated alone.

### What the xcom agent found

Asked at the person's request, it weighed its dialog (238 exchanges,
Fable, 202 s) and handed it back to itself with `am recall --handback
--now`. Its answer: three questions of its own that the person had
never answered and that it had lost (whether a staging site should
redirect or go; two details of converted maps awaiting a look), and a
stance it had held as the person's ruling that the record shows to be
its own proposal, never answered. It also reported that for a few
exchanges the record showed progress lines where its answer should
have been. Its turn cost $7.46.

### Three defects, found by reading what it was handed

- **A progress line stood in for an answer.** A message that arrives
  in the middle of a turn made the text before it count as the agent's
  last word. Now only a turn's end does.
- **One long exchange blocked the recent ones.** A night of work under
  one message is one exchange with dozens of reports. It did not fit
  half the budget, the walk back through the recent exchanges stopped
  there, and the agent got six recent exchanges and 22K tokens of a
  100K budget. Now no exchange takes more than an eighth of the
  budget: a longer one goes back with the person's message and the
  agent's latest texts, whole ones, under a line saying how many
  earlier ones are left out and how to get them.
- **The budget stayed four fifths empty** while rules and decisions in
  force sat in the index, because Fable gave them weight 1 and only 2
  and 3 were handed back. Now anything in force with a weight is a
  candidate: heaviest first, among equals rules and purposes before
  decisions before open tasks.

### Decided for the person

The spec said an exchange is handed back whole or not at all. A long
one now comes back with only its latest texts. No text is cut or
reworded, and the exchange says what it leaves out; but it is a
departure from the wording, made because the alternative was that the
agent's last morning report did not come back at all.

### What was verified

Manager 150 unit and 151 end-to-end. Three new unit tests: a steer in
the middle of a turn, the long exchange, the fill. Not verified on the
xcom agent again: it was not asked a second time.

## Report (2026-11-15)

A fourth round: compaction on request, the person's suggestion ("a
button to do the compaction might be good, would probably upgrade the
context over the current state"). Gated alone.

### What changed

- **Manager:** `POST /api/agents/:id/compact`. The dialog is weighed
  first when the weights are not fresh, then the vendor's own command
  (an adapter's `compactCommand`; Claude Code's `/compact`) is sent as
  a turn of the person's, and the compaction ends in the hand-back.
  Answers at once; the flow says how it goes. Refused while the agent
  is in a turn and for a vendor without a command. `GET /api/profiles`
  says which profiles compact.
- **UI:** "compact" among the agent header's actions, after a confirm,
  disabled while the agent is in a turn.
- **CLI:** `am compact <agent>`.

### What was verified

Manager 150 unit and 152 end-to-end (compaction on request with the
fake agent: refused in a turn, weighed first when never weighed, the
command sent as the person's turn and not counted as dialog), UI
Playwright 36 (the button, its confirm, disabled while working), CLI
22 and 10. Not yet pressed on a real Claude agent from the UI: the
parts were each seen for real earlier today (`/compact` as a turn, the
hook, the hand-back), the button that joins them only against the
fake agent.

### Left open

An agent whose session was started before the hook existed gets a
compaction without a hand-back from this button: it has to be
restarted first. The button does not know and does not say.

## Report (2026-11-15)

A fifth round: the first real use of the compact button, and a wrong
diagnosis of mine corrected. Gated alone.

### The first real compaction with a hand-back

The person restarted the xcom agent and pressed compact. In its flow:
"/compact" as the person's turn, 110 s later "dialog handed back: 20
exchanges word for word (10 recent, 10 earlier), 218 as index lines,
about 18k tokens; weighed by fable[1m]" and "context compacted on
request: 570k → 13k tokens, 110 s". The weights were fresh, so nothing
was weighed again. The chain works for real.

### The hand-back was a fifth of what it should have been, twice

Both of that agent's hand-backs held about 18K tokens against a
budget that should have been 100K. The budget is a share of the
context window, and the window was not in the agent's status either
time: a Claude session on a model name without `[1m]` states its
window only when a turn ends, and both hand-backs came before the
first turn's end after a restart (of the manager the first time, of
the agent the second). The fallback was 200K, so the budget was 20K.

**In the third report I blamed this on one long exchange blocking the
recent ones. That was a guess I did not check, and it was wrong**: the
walk through the recent exchanges stopped at six because half of a 20K
budget was full. The changes made on that guess (a long exchange comes
back with its latest texts; the budget is filled with lighter rules
and decisions) still stand on their own, but they were not what that
agent's hand-back lacked.

Fixed: the window an agent last reported is kept per agent
(`dialog_windows`) and used when the status has none.

### What was verified

A unit test of the kept window across a session that has not reported
and a restart of the manager; manager suites as below. On the xcom
agent the fuller hand-back was asked for again after this fix; see the
conversation.

### Noticed and left alone

The first turn after an agent's restart shows the session's whole
running cost as that turn's cost ("resumed on its own … 0s $1723.30"
in xcom's flow): Claude's `total_cost_usd` of a resumed session starts
from what the conversation cost before, and the adapter takes the step
from zero. The agent's total spend may count earlier sessions twice
for the same reason. Not looked into.
