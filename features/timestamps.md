---
title: timestamps
status: done
priority: 100
---

timestamps at relevant times especially when waiting for background task and maybe we could build something into the manager that pokes the agent to check if its background tasks a live every 30 minutes or so - i have some times found an agent waiting for something that failed to notify

## Report (2026-09-13)

Times: every transcript item now carries the time of the daemon record
it came from. The turn-end rule shows when the turn ended, system notes
(session started, background job started or finished, resumed on its
own) show their time inline, a permission card says since when it has
been waiting, and a user bubble shows its time on hover. The agent
header says "waiting on N background jobs for 12 min" while the agent is
idle with jobs pending.

Watchdog: an agent idle with background jobs and no activity for thirty
minutes (`AGENT_MANAGER_BACKGROUND_POKE_MS`) is sent a short turn asking
it to check whether the jobs are still alive and to act on or report
what it finds; at most one poke per interval, none while the daemon is
disconnected. The poke shows in the transcript as a turn with no
sender, so it is clear the manager asked. Verified by a manager test
with the fake agent and a short interval, and by the UI test for the
turn-end time. Left open: nothing.
