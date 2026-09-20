Which model for which work, kept simple until the run log says
otherwise. As of 2026-09-20 this rests on one day and a handful of
rounds; each line says what it rests on. The choice is profile, model
and effort together; no run has used a non-default effort yet.

### Design work, and anything decided by taste

A screen's layout and wording, the shape of an interaction, the
phrasing of a note, the framing of a feature.

- **Claude Fable 5.1** (`--profile claude --model claude-fable-5-1`):
  the session that holds the conversation, and the reader for
  curation. It got the better UI result in one round where a cheaper
  model took three (learnings #3, #23).
- **Codex gpt-6-astra** (`--profile codex --model gpt-6-astra`): the
  other eye. Its curation reading found the cost error and the wrong
  prohibition in the method on the first day (learnings #26 to #30).

### Coding tasks: the manager, the daemon, the adapters, the CLI, wiring

- **Claude Opus 4.8** (`--profile claude --model "claude-opus-4-8[1m]"`):
  the default, as of 2026-09-20, on one run here and the person's
  experience elsewhere. The run: brought in by the method with the
  vision first, it re-derived the feature from its purpose, replaced
  the suggested mechanism with a better one, found a guard the feature
  had missed by planning the verification first, and disclosed in its
  debrief what it had not read. 9 min, $4.95, gates green in three
  repositories (learnings #38 to #42). It reads for intent, which is
  what the method asks of a colleague with less context. One wrong
  claim, made confidently. The next rounds go here by default so the
  sample fills in; this line is revised as they come.
- **Claude Opus 5** (`--profile claude --model claude-opus-5`): the
  alternative, and the choice where exactness is the point: a vendor
  stream, a protocol, a poller's timing. Four rounds and a batch on
  record: exact readings, tests for the parts that were hard to see,
  plans that changed the spec for the better, gates green on the first
  pass twice of three, reports that named defects in their own work.
  Half the time and well under half the cost of Sonnet 5 on the one
  near-comparable pair (learnings #14, #22). It reads for what was
  said; it implemented a Response's odd wording literally and flagged
  it, which is the right behaviour under a good brief and the wrong
  one under a thin one.

### Not on the list

- **Claude Sonnet 5**: two manager rounds and three UI rounds on
  record, and no working strategy yet: it did the sentences of a brief
  and nothing between them, and it delivered a green suite over a
  screen nobody had looked at (learnings #3, #4). Off the list until
  the log shows a kind of work and a way of briefing that suits it.
- Anything smaller: untested.

### When not to delegate at all

Work whose specification is the conversation that produced it. It
stays in the session that holds it, on Fable.
