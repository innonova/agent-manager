---
title: what the agent is doing right now, on its status
status: planned
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
