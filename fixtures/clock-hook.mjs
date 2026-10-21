#!/usr/bin/env node
// A Claude Code PostToolUse hook that tells the model what time it is, at
// most once per interval: agents with a time box overestimate the passage
// of time, and a clock beside a tool result every ten minutes keeps them
// grounded without a message in the transcript. Claude hands the hook
// its event on stdin (with the session id); the hook keeps a stamp per
// session and prints `additionalContext` only when the interval has
// passed since it last spoke. The first tool call of a session gets one
// too, so the agent starts on the clock.
//
//   node clock-hook.mjs [--every <ms>]     (default 600000; 0 prints never)
//
// The manager turns it on with a settings file passed to Claude at
// session start (see the Claude adapter); AGENT_MANAGER_CLOCK_STATE_DIR
// moves the stamps (tests).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const everyIdx = args.indexOf('--every');
const every = everyIdx >= 0 ? Number(args[everyIdx + 1]) : 600_000;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  if (!every || every <= 0) return;
  let session = 'unknown';
  try {
    session = String(JSON.parse(input).session_id ?? 'unknown');
  } catch {
    /* no event: still answer with a stamp per process */
  }
  const dir = process.env.AGENT_MANAGER_CLOCK_STATE_DIR || os.tmpdir();
  const stamp = path.join(dir, `am-clock-${session.replace(/[^A-Za-z0-9_-]/g, '_')}`);
  const now = Date.now();
  let last = 0;
  try {
    last = Number(fs.readFileSync(stamp, 'utf8')) || 0;
  } catch {
    /* first call of the session */
  }
  if (last && now - last < every) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(stamp, String(now));
  } catch {
    /* a stamp that cannot be kept means a clock every call; still correct */
  }
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  const text = `The time is ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} (${tz}).`;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text },
    }),
  );
});
