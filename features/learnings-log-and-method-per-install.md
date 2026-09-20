---
title: the method and a learnings log, per install, for every project
status: planned
priority: 55
---

`docs/method.md` describes how work is run under the manager: features,
the gate, helpers, reviews, debriefs. That is not this repository's
concern but every project's on the machine, so it belongs with the
harness note and the models file: shipped with the manager, seeded
into the config directory, edited in the UI, readable by every agent.
And the method should rest on a record, not on one day's memory: an
append-only log of what was learned running agents and working with
them, curated into the method now and then.

**The method file.** `method.md` moves from `docs/` to the repository
root and rides on the same terms as `models.md`: installed next to
`dist/`, seeded into `~/.config/agent-manager/method.md` by the
installer's three-way rule, a third note-file kind (`GET`/`PUT
/api/method`, a hub forwarding by host), a size cap that fits a few
pages. It is not rendered into the harness note (too long); the note
says where it is and that `am method` prints it, and the design doc
keeps a one-paragraph pointer where `docs/method.md` was.

**The learnings log.** One per install, append-only, kept by the
manager as data, not as an operator file: `<dataDir>/learnings.md`,
one entry per paragraph with a header line the manager writes:

```
## 2026-09-20 11:30 · agent-claude · run 9ae50a37 · feature run-log-for-model-comparison

The run's spend read zero although its turns cost about $31: the
manager was reinstalled during the run and the usage difference lost
its starting point.
```

An entry is an observation with evidence: what happened, and a
pointer (a run id, a feature slug, a commit, free text) when there is
one. Rules and conclusions do not go in the log; they go in the method
after curation. The manager only ever appends; a curation is itself an
entry (`curated` in the header, saying up to which entry it read and
which commit changed the method). API: `POST /api/learnings { text,
ref? }` appends and returns the entry (`{ n, at, by, ref, text }`, `n`
counting from 1); `GET /api/learnings?since=<n>&host=` lists entries
after `n`, newest last; a hub forwards by host. Agent tokens may
append and read (a helper mid-work is the usual author). Nothing edits
or deletes an entry; a wrong one is answered by another.

**In the harness note**: one line saying the method is what `am
method` prints, and that `am learn "<text>"` records something learned
about working here, at the moment of noticing.

**Design doc**: a Learnings section (the shape, append-only, the
curation entry), the API lines, the config rows (`AGENT_MANAGER_METHOD_FILE`
if any). The UI page (`/method` as a third kind of the note-file
page, `/learnings` as a list with a way to add an entry) and the CLI
(`am method`, `am learn`, `am learnings [--since N]`) are the sibling
repositories' parts; name them in the report.

Verification worth planning: the installer's seeding of a third file
(it has now run for two files on two machines; a shell-level test of
`seed_config_file` against a temp dir would end the "untested in
execution" note for good); append-only under concurrent posts; the
hub forwarding of both routes; agent tokens on both routes.
