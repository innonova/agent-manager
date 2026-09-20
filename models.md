What we have learned about running work on different models, as of
2026-09-20, kept by hand — the house view an agent has in front of it
when it picks the model for a helper it starts. It is a view rather
than a rule: the result depends as much on the brief and the context
the helper is given as on the model. The run log is where the evidence
accumulates; this is the conclusion drawn from it so far.

### Claude Fable 5.1

Design, and anything with taste in it: a screen's layout, its wording,
the shape of an interaction. Also the natural place for work whose
specification is the conversation that produced it, since that
conversation is what it is good at holding.

### Codex gpt-6-astra

The other eye for UI design. Worth asking when a screen has been
through one pass already and still looks like the first idea.

### Claude Sonnet 5

Wiring up a UI someone else designed, and manager work with a tight
spec. The pace is slower, and the failure mode is a green test suite
over work nobody looked at: a feature it gates reads as finished while
the screen it changed went unopened. Screenshots, and a reading of the
diff, are what that costs.

### Claude Opus 5

A manager round in ten minutes (2026-09-20, the third round of the
agent-activity feature): an exact reading of the vendor stream, tests
for the parts that were hard to see, and a caveat in its report about
the one place the spec's wording had a consequence. One run so far.
