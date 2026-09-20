---
title: a log of feature runs, for comparing models
status: planned
priority: 60
---

We start delegating feature work to helpers on different models
(Sonnet, Opus, Codex, Bedrock). To learn which model is realistic for
which kind of work we need the runs on record, comparable, and kept
after the helper is forgotten. Today the pieces are scattered: the
feature's commit range is on the feature, the transcript is in the
daemon log (gone with `DELETE /api/agents/:id`), the model on the agent
row, the spend on the status.

A run is one agent's work on one feature: it begins when the feature
goes `in-progress` while that agent has a turn under way in the
project, and ends when the feature leaves `in-progress` (`review`,
`blocked`, `done`) or the agent's turn ends without that. The poller
already sees the transitions and records the feature's base commit; it
attributes the run to the working agent whose cwd is the feature's
repository, else the only working agent in the project, else none.

Record, in a `runs` table and a file per run under `<dataDir>/runs/`:

- agent id and name, profile, model, effort, permissions; the host;
- project, repository, feature slug, the status the feature ended in;
- started and ended at; the base and end commit of the repository (the
  end taken when the run ends, so a run that did not commit shows the
  same hash twice);
- the turn count and spend during the run (tokens in and out, dollars
  where the vendor prices them), as the difference of the agent's
  usage between start and end;
- the transcript of the run: the items between its first and last
  record, exported as NDJSON to the run's file at the end, so it stays
  when the agent is forgotten;
- the report the agent appended, as text.

API: `GET /api/runs` (filters: project, feature, model, since), `GET
/api/runs/:id` with the transcript, and the CLI `am runs [project]`
printing a table (feature, model, duration, commits, cost, outcome).
No UI page in this round; a block on the projects page can follow once
we know what we want to look at. Design doc: a Runs section.

Not in scope: judging quality. The log is the raw material; the
judgement is a person reading the transcript and the diff with the
numbers beside them.
