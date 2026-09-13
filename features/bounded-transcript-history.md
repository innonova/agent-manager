---
title: bounded transcript history
status: done
priority: 20
dependsOn:
  - lifecycle-tests-scripted-daemon
---

Not yet: needs a design discussion first (blocked until then).

Every agent's normalised transcript stays in memory and is rebuilt from
the daemon on every restart, archived agents included. Fine for weeks,
bad for months; the failure mode is a restart that cannot complete.
Page transcripts, load archived ones on demand, keep the daemon log as
the source of truth it already is, and keep item indexes stable for
clients. Decide first: what stays resident (the current session's
items? the last N?), what the API looks like for older items, and how a
rebuild after restart avoids reading every log in full.

## Report (2026-09-13)

Done, on both sides, deployed.

Manager (`agent-manager`):

- New `src/agents/transcript-cache.ts`: one append-only NDJSON file of
  items per agent plus a small header, under `<dataDir>/transcripts/`.
  Offsets every 256 items make a range read cheap; a file longer than
  its header is cut back on load; corrupt, missing or old-version
  headers just mean a rebuild from the daemon log.
- Adapters gained `snapshot()`/`restore()` for their cross-turn state
  (Codex thread and pending rpc ids, Copilot session, Claude's
  backgrounded tasks, the handshake bookkeeping `afterReplay` relies on).
  A unit test proves, on every recorded fixture, that restoring at the
  first turn end and feeding the rest gives the same items, states,
  sends and background counts as one uninterrupted replay.
- The agents service settles a session at each `turn_end` and at its
  "session ended" item, writes the cache then (or once at the end of a
  replay), and keeps only a resident tail (`AGENT_MANAGER_RESIDENT_ITEMS`,
  500) in memory; `itemBase` keeps indexes stable. On restart the tail
  and per-session snapshots are loaded and the daemon replayed only from
  the cached sequence; the current session starts from its cached
  status. Archived agents are skipped at start and loaded on first
  request. A cache the log contradicts is dropped and rebuilt.
- `GET /api/agents/:id/items` now takes `tail=`, `before=&limit=` or
  `from=` and returns `total`.
- Tests: transcript cache unit tests; five scripted-daemon lifecycle
  cases (restart continues from the cache with the attach starting past
  the last turn end and nothing re-sent; restart mid-turn; paging;
  archived agent untouched at start and loaded on request; contradicted
  cache rebuilt). The whole lifecycle suite now runs with a resident
  tail of 6 so the cache is on every test's path.

UI (`agent-manager-ui`):

- Transcripts open on the last 300 items; the list is index-keyed and
  as long as the history, with holes for pages not loaded. Scrolling to
  the top loads the previous page and keeps the reader's place; a
  "load earlier" button does the same. A store unit test covers the
  paging and the reconnect refetch.

Left as agreed: nothing on disk is trimmed (daemon log or cache).

Review round (same day): Codex deep pass on the manager change, Claude
light pass on the UI. All findings fixed and covered:

- an earlier session whose replay failed could be cached partially and
  its recovered records appended after later history on the next start;
  every cached session but the last must now be whole, or the agent is
  rebuilt (lifecycle test with a refused attach, then recovery);
- a write in flight during a rebuild evicted uncached items of the new
  transcript; writes and reads carry a generation and stand down;
- an exit notice arriving while the cache loaded left a blank adapter
  in place of the restored one;
- a session the daemon no longer has, or one the database does not
  know, now invalidates the cache instead of lingering;
- a paged read racing a rebuild could fail or mix generations; it
  retries;
- an archived agent whose replay failed was never retried; it is, on
  the next request, and the cached tail is served with the daemon down;
- a rejected header left the old items file underneath a rebuild; a
  rejected header takes the file with it, and an append checks the file
  length first.
- UI: items held during a load kept the old numbering across a reset;
  a reconnect refetch that came back shorter never truncated the list.

Second review round (Codex, same day) verified the fixes and found
two more, both fixed and covered by lifecycle tests: an archived agent
with a session that cannot be replayed was rebuilt and reset on every
request (now once per daemon connection); a corrupt line in one
agent's cache tail escaped and aborted the resync of every agent after
it (now that agent rebuilds and the others proceed). A session the
daemon no longer has is now dropped at the next resync, as it would be
at the next start.
