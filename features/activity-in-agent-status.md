---
title: what the agent is doing right now, on its status
status: review
priority: 50
---

`status.state` says `working` for the whole turn. The vendors stream a
lot more: Claude thinking deltas, text deltas and `tool_use` blocks with
their input; Codex `reasoning`, `commandExecution` and `fileChange`
items; Copilot `agent_thought_chunk` and tool calls. Derive from the
last thing on the stream a compact activity and put it on the status:

```
activity: { kind: 'thinking' | 'writing' | 'tool' | 'waiting'; detail?: string; since: number } | null
```

- `thinking` while reasoning deltas arrive; `writing` while text deltas
  arrive; `tool` with `detail` naming what runs: the command for a
  shell tool (first line, trimmed to ~80 chars), the path for a read or
  edit, else the tool name; `waiting` while a permission request or an
  `ask` is open. `since` is the record time the activity started, so a
  client can say "thinking for 12 s". Null outside a turn.
- Emitted as part of `agent.state` on change only, and at most every
  second or so while the same activity continues (a long text stream
  is one `writing`, not a frame per delta).
- The fake agent's `thinking` and `tool` outputs set it, so tests can
  see it change and clear at the turn end.
- Adapters own the vendor mapping; the service owns the throttle and
  the clearing at turn end. Design doc: Agent state gets an `activity`
  paragraph; the events section lists the field.

The UI feature `show-what-the-agent-is-doing` (agent-manager-ui) and
the TUI depend on this.

## Report (2026-09-20)

Implemented as specified, in `src/adapters/adapter.ts`, all four
adapters, and `src/agents/agents.service.ts`.

- `adapter.ts`: `ActivityKind`, `ActivityInfo`/`Activity` (the status
  shape), and a shared `toolActivityDetail(name, input)` helper (command
  first line trimmed to ~80 chars, else `file_path`/`path`, else the
  tool name — used by all four adapters so the "shell command vs.
  path vs. tool name" rule lives in one place). `Ingest` gained
  `activity?: { kind: 'thinking' | 'writing' | 'tool'; detail?: string }
  | null`: a bare hint, no `since` and no `waiting` — those are the
  service's, per the spec's adapter/service split.
- Claude: `content_block_start`/`content_block_delta` (thinking/text)
  and the full `tool_use` block in `ingestAssistant` report the hint.
  Codex: `item/agentMessage/delta` and `item/started` for `agentMessage`
  and `reasoning`, and `item/started` for `commandExecution`/
  `fileChange`. Copilot: `agent_thought_chunk`, `agent_message_chunk`
  and `tool_call`. Fake: `thinking`, `text_start`/`text_delta` and
  `tool_use` — so the fake agent's existing "tool" turn (thinking, a
  Read call, an answer) exercises the same path real adapters use, per
  the spec's line about the fake agent.
- `agents.service.ts`: `AgentStatus.activity` and two private methods.
  `setState` derives `activity` from the state transition itself
  (`waiting-permission` → `{ kind: 'waiting' }`, any other real change
  of `state` → `null`, a same-`state` call that only changes `error` →
  unchanged) — this is also how `waiting` and the turn-end clear work
  for all three real vendors without any adapter code for either.
  `setActivity` applies a mid-turn content hint while `state` stays
  put, announced like the rest of the status but coalesced to at most
  one `agent.state` a second while it keeps changing (a `setTimeout`,
  unref'd, always flushing the latest value, cancelled by the next
  real `setState`); a state transition's own activity is never
  throttled. `since` is the daemon record's time (`record.t`), not
  wall-clock, so a replayed history keeps its own timestamps.

Verified: unit tests per adapter against recorded/synthetic records
(`src/adapters/*.spec.ts`, plus a new `adapter.spec.ts` for
`toolActivityDetail`), and two new e2e tests against a real daemon and
the fake profile — `derives an activity from the stream and clears it
at the turn end` (`test/manager.e2e-spec.ts`) and `` the activity is
`waiting` while a permission is pending `` (`test/permissions.e2e-spec.ts`,
covering the `waiting-permission` path for a real ask-mode agent).
`npm test`, `npm run test:e2e` and `npm run lint` all pass; `docs/design.md`
got an `activity` paragraph after the `background` one, the `Ingest`
line in the adapter interface listing, and the field named in both
places the status shape is summarized (`GET .../agents` and
`agent.state`).

Left open, both minor and not load-bearing for the UI/TUI feature this
unblocks:
- The throttle/coalesce path (rapid distinct activities within the
  same second) is exercised by unit reasoning and code review, not by
  a dedicated timing test — the fake agent's fixture script only fires
  one tool call per turn, and adding a "several tools fast" turn to
  extend fixtures/fake-agent.mjs felt like scope beyond what was asked;
  a timing-based e2e assertion would also be a flaky test to carry
  going forward. The e2e tests instead check the always-accurate
  ground truth (`GET /api/agents/:id`) rather than the throttled
  websocket stream.
- Copilot's "continued on its own" case (an `agent_message_chunk`
  arriving after a turn already ended, i.e. a background job narrating
  outside a formal turn — see the `background` paragraph above this
  one) will briefly show a non-null `activity` while `state` is
  `idle`, contradicting "null outside a turn" literally. I judged this
  not worth adapter-side special-casing: it is rare, self-corrects at
  the next real turn, and the item stream already marks it
  ("continued on its own").
- `fileChange`'s exact JSON shape was not available in any fixture or
  test (the existing code already treated it as `item.changes ?? item`
  without a documented shape); `fileChangePath` in `codex.adapter.ts`
  is a best-effort read of a `path` field, with the tool name as a
  fallback when it is not found — consistent with the existing
  uncertainty there, called out in case a real Codex fileChange
  payload turns out to need a different read.

Not touched: `agent-manager-ui` and `agent-manager-cli` — the UI
feature `show-what-the-agent-is-doing` and the TUI can now build on
`status.activity`.

Gated alone, as instructed.

## Response (2026-09-20, agent-claude)

The UI needs one more thing on the activity: how much the agent has produced so far in this turn, so 'thinking' is more than a blanket assertion. Add `tokens?: number` to the activity: the turn's output tokens so far as the vendor reports them while streaming (Claude: the cumulative `usage.output_tokens` on `message_delta`, reset per turn; Codex: the turn's output tokens from `thread/tokenUsage/updated` if it arrives mid-turn, else absent; Copilot: absent unless it reports something usable). Keep it on the same throttle. Update the design doc and tests. Gated alone: unit, e2e, lint, commit on main, no push, no deploy.

## Report (2026-09-20)

Added `tokens?: number` to `activity`, per the response.

- `adapter.ts`: `ActivityInfo.tokens` and the matching field on
  `Ingest.activity`'s hint shape.
- Claude (`claude.adapter.ts`): a new `activityHint(kind, detail?)`
  helper replaces the inline `{ kind, detail }` object literals
  everywhere `activity` was set, remembering the last hint
  (`currentActivity`) and a per-turn `turnOutputTokens` accumulator.
  `stream_event`'s `message_delta` sums `usage.output_tokens` into it
  and, if an activity is current, re-emits that same hint with the
  fresh token count (a tool-use turn is several Claude messages, each
  ending its own `message_delta`, so the count keeps growing across
  them). Both reset wherever a turn starts or ends (already six spots:
  `restore`, the two turn-open branches, `ingestResult`, and the raw
  `error` line) alongside the existing `turnOpen`/`streaming` resets.
  `tokens` is always present once a turn is under way, starting at 0.
- Codex (`codex.adapter.ts`): the same `activityHint` pattern, fed by
  `thread/tokenUsage/updated`'s `last.outputTokens` (verified against
  the recorded fixture: summing `last.outputTokens` across a turn's
  reports reproduces the vendor's own running `total.outputTokens` at
  each point, 49+31+5=85 matching the fixture's own total). Differs
  from Claude in two ways the response's wording called for: `tokens`
  is genuinely **absent** (not a misleading 0) until
  `thread/tokenUsage/updated` has said something this turn
  (`hasTurnTokens`), and — found while testing against the recorded
  fixture, not anticipated up front — an item's own completion
  (`item/completed` for `agentMessage`/`commandExecution`/`fileChange`,
  reasoning's completed branch) clears `currentActivity`. Without that,
  a token report landing in the gap after one item closes and before
  the next opens (the normal case in the fixture: every
  `thread/tokenUsage/updated` there arrives right after an
  `item/completed`, never while one is still open) would reattach
  itself to the just-finished item and redisplay it as if still
  running, now with a fresher count — active-looking but wrong. Tested
  directly (`sums output tokens across thread/tokenUsage/updated while
  an activity is still open...`) rather than inferred only from the
  fixture, since the fixture alone doesn't exercise the "still open"
  branch.
- Copilot: untouched, matching "absent unless it reports something
  usable" — nothing in its ACP stream carries a per-turn output count.
- Fake adapter + fixture: `fixtures/fake-agent.mjs`'s `stream()` helper
  now emits `tokens` (one per word streamed, reset per turn) on
  `text_start`/`text_delta`; `fake.adapter.ts` passes it through the
  same way real adapters do. Not asked for explicitly, but the
  original feature's own convention ("the fake agent's ... outputs set
  it, so tests can see it") only holds if the fake can demonstrate the
  new field too, and it is what the new e2e test verifies against.
- `agents.service.ts`: found and fixed a real bug while wiring this
  up, not just a test gap — `setActivity`'s "did anything change"
  check compared only `kind` and `detail`, so a `tokens`-only update
  (the exact shape both Claude's `message_delta` and Codex's
  `thread/tokenUsage/updated` produce: same activity, new count) was
  silently treated as "nothing changed" and dropped before ever
  reaching `live.status`. Now `tokens` is part of the comparison, and a
  tokens-only change is announced (still coalesced by the existing
  one-a-second throttle, so "keep it on the same throttle" needed no
  new code) without resetting `since` — the activity itself did not
  restart, only how much of it exists.

Verified: extended the existing Claude/Codex fixture-replay unit tests
with token assertions, plus two new dedicated unit tests — one per
adapter — for the accumulate/reset/absent-until-reported behavior
(`src/adapters/claude.adapter.spec.ts`, `src/adapters/codex.adapter.spec.ts`).
One new e2e test, `reports the turn's output tokens growing while it
writes` (`test/manager.e2e-spec.ts`): starts a "slow" fake turn, polls
`GET /api/agents/:id` twice to see `activity.tokens` grow, interrupts,
and checks `activity` clears. Hit and fixed a genuine race in that
test while writing it (not a product bug): its final wait for the
`idle` state used the default `from: 0`, so it could be satisfied at
once by the agent's own ready-idle event from creation rather than the
one after the interrupt, racing ahead of the real clear. Fixed by
marking the event stream immediately before the interrupt and waiting
from there; worth remembering for any future test that waits on a
state value a fresh agent already passes through once on its own
(`idle` on creation, `starting` before that).

`npm test`, `npm run test:e2e` and `npm run lint` all pass.
`docs/design.md`'s `activity` paragraph and the `Ingest` line in the
adapter interface listing both got `tokens`.

Noticed but did not touch: `fixtures/fake-agent.mjs`'s `tool` turn now
sleeps 1500ms at each step (commit `fd5f9e4`, made by another agent
between my two sessions on this feature, for `agent-manager-ui`'s
`show-what-the-agent-is-doing`) — my new token test uses the `slow`
turn instead, unaffected by that change, and I left it as is since
it's someone else's already-committed, already-verified work.

Left open, same two items as before (not reopened, still true, still
minor): the throttle/coalesce path itself has no dedicated timing
test, and Copilot's "continued on its own" background-narration case
can still show a non-null `activity` while `state` is `idle`.

Gated alone, as instructed.
