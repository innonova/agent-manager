---
title: lifecycle tests with a scripted daemon transport
status: in-progress
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
