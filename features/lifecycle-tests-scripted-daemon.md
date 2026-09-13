---
title: lifecycle tests with a scripted daemon transport
status: review
priority: 10
---

Deterministic manager tests that drive a fake daemon frame by frame, so a
test can cut the connection at any point in a vendor handshake, deliver a
permission answer before or after its input echo, reject an interrupt,
lose a turn's acknowledgement, or restart the manager mid-turn, and then
assert exactly what the manager sends to the daemon and shows to clients.

Use the recorded vendor fixtures under `test/fixtures/` as the daemon's
script where a real exchange is needed. No vendor tokens. Cover, at
least: every handshake cut point for Codex and Copilot (nothing logged,
initialize logged, initialize answered, thread or session logged);
permission answers delivered, refused and lost, with the reservation
released; a refused Codex interrupt; attribution of a recovered turn; a
restart while waiting for a permission. These are the cases three review
rounds found by hand.

## Report (2026-09-13)

`test/scripted-daemon.ts` is a daemon the test drives: a websocket
server speaking the frames the manager's client uses (session start,
attach with replay, input, end-input, signal, get, list, profiles), with
a log per session that survives a cut connection, and hooks to emit
output, answer or refuse an input, cut the connection before or after an
input is recorded, and end a session. `test/lifecycle.e2e-spec.ts`
drives the manager against it with a scripted Codex behind: ten cases
covering the three handshake cut points plus the everything-logged
restart, a permission answer refused, lost before recording, and
recorded but unacknowledged, a restart while waiting for a permission, a
rejected interrupt, and attribution of a recorded-but-unacknowledged
turn next to a never-recorded one. All pass, in about ten seconds, with
no processes and no tokens.

One thing the suite taught: after a cut the old manager reconnects
within its backoff and can finish a handshake before a test restarts
it, so tests check states by polling the API where an event may have
fired before their socket existed. Documented in the design doc's
Testing section. Left open: Copilot and Claude scripts (the scripted
daemon is vendor-neutral; only Codex has a script so far).
