---
title: view usage for an agent
status: review
priority: 100
---

ability to view current usage data for each agent account

## Report (2026-09-13)

Done and deployed. What each vendor tells us, normalised into
`status.usage` on the agent and collected per machine and profile:

- Claude Code reports its rolling windows in `rate_limit_event` frames
  during a turn: the 5-hour and 7-day utilisation, each with its reset
  time, and a verdict (ok, warning, rejected).
- Codex reports `account/rateLimits/updated` with its primary and
  secondary windows (used percent, window length, reset time) and the
  plan.
- Copilot exposes no account quota over ACP; it reports the session's
  context use (`usage_update`), shown as "ctx N%".

Where it shows: a chip in the agent header ("5h 33% · 7d 41%", amber
from 80%, red when rejected, tooltip with reset times and the plan), an
"Account usage" block on the projects page per machine and vendor
(`GET /api/usage`, which a hub merges from its spokes), the TUI's
header line and `am agents`. Refreshed whenever an agent reports new
usage. Unit tests for the three adapters' frames and the fake agent's
`usage N` turn; an e2e test checks the status and the endpoint.

Not done: no history or graph, only the latest report; nothing polls
the vendors, so a machine whose agents have not run shows nothing.

Addendum: every window Claude reports is now shown, named by family
(5h, 7d, the overage-included one labelled `fable` since it is the figure Claude Desktop shows as Fable, and per-model ones such as "7d opus" or a Fable
one when Claude sends it; the binary knows Sonnet and Opus windows
today, and any new key shows up by its name without a change here).
The session's spend (tokens, turns, dollars) and the provider are
carried too, which is what shows on Bedrock or Vertex, where there are
no account windows.

Addendum: the vendors' spend counters (Claude's `total_cost_usd`,
Codex's token totals) are per process, so a restarted agent looked as
if its earlier spend had vanished. The manager now keeps each
session's last reported spend in the transcript cache and adds the
earlier sessions' final figures to the current one's as `total`; the
header chip and the TUI show the total, and the tooltip gives both the
total and the part since the last restart. The cache version bumped for
the new per-session field, so every agent's transcript is rebuilt once
from the daemon log on the next manager start.
