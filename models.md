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

- **Claude Opus 5** (`--profile claude --model claude-opus-5`): the
  working default. Four rounds and a batch on record: exact readings
  of the vendor stream, plans that changed the design for the better,
  reports that named defects in their own work, gates green on the
  first pass twice of three. Half the time and well under half the
  cost of Sonnet 5 on the one near-comparable pair (learnings #14,
  #22).
- **Claude Opus 4.8** (`--profile claude --model claude-opus-4-8`): the
  next experiment. The person's experience elsewhere is that it
  reasons more like the session holding the conversation, whatever it
  lacks in particular coding measures. No run here yet.

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
