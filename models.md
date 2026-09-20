What we have learned about running work on different models, as of
2026-09-20, kept by hand and organised by the work, because that is how
a chooser reads it. A view rather than a rule: the result depends as
much on the brief and the context the helper is given as on the model,
and the run log (`am runs`) is where the evidence accumulates, with a
cause recorded when work is sent back (the model, the brief, or a
missing doc fact). The choice is profile, model and effort together.

What this rests on today: one day, three helpers, nine feature rounds,
read from transcripts and the daemon logs, not from the run log, which
came into being that afternoon and holds two rows. No run has used a
non-default effort, so every effort line below is untested. The per-turn
costs are from the daemon records (learnings #14): the turn-end line
in a transcript showed the session's running total until then.

### When not to delegate

Work whose specification is the conversation that produced it, and
anything decided by taste: a screen's layout and wording, the shape of
an interaction, the phrasing of a note. That stays in the session that
holds the conversation, on a frontier model. Delegation pays when the
work can be written down as a feature file, which is also the test of
whether it can.

### Design, and anything with taste in it

Claude Fable 5.1, or Codex's gpt-6-astra as the other eye once a screen
has been through one pass and still looks like the first idea. Effort:
untested. Not a cheaper model: a green test suite over a screen nobody
looked at is the failure mode on record.

### Manager and daemon work: the service, adapters, protocol

Claude Opus 5, effort default. Four rounds and a batch of two on
record (2026-09-20): an exact reading of the vendor stream, the tests
for the parts that were hard to see, plans that changed the spec for
the better, gates green on the first pass twice of three, and a
debrief that named a defect in its own work. On the one near-comparable
pair, an adapter round each on the same files with different asks:
10 min and $5.55 against Sonnet's 18 min and $13.33. About half the
time, well under half the cost; the two rounds differed in what they
inherited, so the size of the gap is not settled.

### Wiring up what someone else designed; tightly specified work

Claude Sonnet 5, effort default. Right when the shape is set and the
tests say pass or fail: adapters, a field on a status, a CLI command.
Two manager rounds ($9.28 and $13.33, 20 and 18 min) and three UI
rounds ($2.67, $1.41, $4.44) on record. Slower; in one round it edited
one file seventeen times (edit counts partly reflect tool style, see
learnings #22), and it did exactly the sentences of a brief and
nothing between them, so the brief has to carry the map. Not for
anything that has to be looked at rather than tested.

### Reading, searching, summarising

Not measured yet. Claude Haiku 4.5 is the candidate for a reading pass
whose output is a summary; a run or two will say.
