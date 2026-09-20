---
title: the method and a learnings log, per install, for every project
status: review
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

## Report (2026-09-20)

Both halves, as planned, with the five answers folded in.

**The method file.** `docs/method.md` → `method.md` at the root (a `git
mv`, so its history follows), a third `NoteFileKind` with a 64 KB cap
(nothing pastes it anywhere, so the harness template's cap fits),
`MethodController` beside the other two, `methodFile`/
`shippedMethodFile` and `AGENT_MANAGER_METHOD_FILE` in the config, and
the installer seeding it. `docs/design.md` keeps a paragraph where the
method was, saying why it is an operator file rather than a document
here. This repository's `CLAUDE.md` points at the new path.

**The installer.** `seed_config_file` moved verbatim into
`scripts/seed-config-file.sh`, sourced by the installer and taking the
install directory as an argument instead of reading it from the
enclosing scope. `scripts/seed-config-file.spec.ts` drives it with
`bash -c 'source …'` over temp directories: seeded, silent when
identical, updated when the copy is still the previously shipped text,
kept when edited, kept when there is no install directory to compare
with, and each file judged on its own. The "untested in execution" note
from two rounds ago is closed.

**The learnings log.** `src/learnings/`: `learnings-file.ts` is the
whole format as pure functions (header, body escaping, parser),
`learnings.service.ts` appends through one promise chain and reads with
`since`, `learnings.controller.ts` has `POST`/`GET /api/learnings` with
the optional `host` on both. The file is `<dataDir>/learnings.md`, so
no config row. `escapeBody` indents a body line that would pass for a
header by one space, and the parser splits only on the exact header
grammar, so no entry can split itself in two — the one real hazard of
keeping records in Markdown.

**Scope.** `scopeAllows` gained two routes outside any project, as
agreed: `GET`/`POST /api/learnings` and `GET /api/method` (not `PUT`).
The harness note gained one line naming `am method`, `am learn` and
`am learnings`; the method itself is not rendered into it.

**Verified.** `scripts/seed-config-file.spec.ts` (6),
`src/learnings/learnings-file.spec.ts` (7: round-trip, paragraphs kept
whole, a body quoting a header, ordinary Markdown left alone, an empty
file, a title above the first entry, CRLF, a name or ref carrying a
newline or a separator), `test/docs-pointers.spec.ts` (a git-grep guard
that nothing outside `features/` names the old path; feature files are
the record of what was said and are not edited), `src/agents/
harness.spec.ts` (the note names `am method` and does not carry the
method's text, and is shorter than it). E2e: `test/learnings.e2e-spec.ts`
(5, including 20 parallel posts numbering 3..22 with no gap or repeat,
and the file's earlier bytes still a prefix of the later ones — the
append-only assertion), and a new case in `test/hub.e2e-spec.ts` that
reads and writes `/api/method` on both machines and keeps each
install's learnings its own. That last one is the first test of the
note-file hub forwarding at all, so it covers the harness and models
files with it.

**A near miss worth recording.** That hub test failed the first time
because `test/helpers.ts` overrode `harnessFile` and `modelsFile` but
knew nothing of `methodFile`: the test manager wrote `# How we work
over there` into the **developer's own**
`~/.config/agent-manager/method.md`. `methodFile` is now overridden
with the others, and I deleted the file the test created (it had not
existed before — dated one minute before I read it). Any future
operator file has to be added in three places at once: the config, the
installer, and the test overrides.

### Noticed, left alone

- **The spend-basis defect** (`RunsService.spendSince` records
  `usage.total ?? usage.spend` at open and subtracts the same
  expression at close, so a manager restart mid-run can subtract
  unlike bases and land on zero or a negative) is yours to enter as the
  log's first entry and to take up in the run log's next round, as you
  said. Noted here so the two records agree.
- **`am method`, `am learn`, `am learnings` do not exist yet**, nor the
  `/method` and `/learnings` UI pages; the harness note promises them
  in the present tense. It says so to every agent at its next session
  start, which is before the CLI lands unless the two are deployed
  together.
- **Three sibling `CLAUDE.md` files still point at
  `../agent-manager/docs/method.md`** (daemon, ui, cli). Yours, as
  agreed; the grep guard here cannot see them.
- **An agent may read every learning on the install**, including
  entries written from another project's work. That is the decision,
  now in the design doc, but it is worth remembering the first time an
  entry names something one project would rather another did not see.
- **`GET /api/learnings` parses the whole file on every call.** Fine
  for a file a person curates; the first thing to hurt if the log ever
  grows past a few hundred entries, and `since` does not help because
  the numbering comes from the parse.
- **From earlier rounds, unchanged:** `runs` has no index on `model` or
  `slug`, and a review emits no event.

Gated alone (a batch of one): cheap checks and this commit, then the
full gate below. Not pushed, not deployed.
