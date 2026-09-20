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
