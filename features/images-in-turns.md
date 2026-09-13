---
title: images with a turn
status: done
priority: 60
---

Paste an image into the chat and have the agent see it, the way the
Claude Code editor extension does. Decided: base64 inline in the input
line, so the daemon log stays the single source and transcripts rebuild
with their images; revisit if large images become common.

## Report (2026-09-13)

Done and deployed.

- Manager: `POST /api/agents/:id/turn` takes `images: [{ mediaType,
  data }]` (base64; png, jpeg, gif, webp; at most four, 3 MB each, 6 MB
  per turn; 400 otherwise), on plain and steered turns and through the
  held-message queue. Each adapter sends the vendor's shape (Claude
  `image` block with base64 source, Codex `image` input with a data URL,
  Copilot ACP `image` block) and reads the images back from the logged
  input (Claude from its echoed user message), so the `user` item
  carries `images` and a rebuild from the log shows them. The turn
  route's body limit is 12 MB; the fake agent notes how many images it
  got. Adapter unit tests cover all four shapes both ways; an e2e test
  sends two images through the fake agent and checks every limit.
- Web UI: paste or drop images into the composer; thumbnails with a
  remove button above it, sent with the text (or alone, as "(image)"),
  cleared once the manager accepted the turn; user items show their
  images as thumbnails that open full size. Playwright pastes a PNG and
  sees it land and be noted by the agent.
- CLI: `am turn --image <path>` (repeatable); the TUI shows `[image]`
  markers on user items.

Not done: drafts do not keep pasted images across navigation; the TUI
cannot take a clipboard image over SSH.
