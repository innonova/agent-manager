#!/usr/bin/env node
// A Claude Code PostToolUse hook: what the manager has to say to a working
// agent beside a tool result, without a message in the transcript.
//
// The time, at most once per interval: agents with a time box
// overestimate the passage of time, and a clock every ten minutes keeps
// them grounded. Claude hands the hook its event on stdin (with the
// session id); the hook keeps a stamp per session and speaks only when
// the interval has passed since it last did. The first tool call of a
// session gets one too, so the agent starts on the clock.
//
// And the chat: that messages from the people are unread, not what they
// say. The hook asks the manager (the session's own AGENT_MANAGER_URL
// and AGENT_MANAGER_TOKEN), which decides whether it is time to say so
// and in which words; a manager that is away or slow means silence,
// within a fraction of a second, never a failed tool call. A tool call
// inside a subagent is not told: the chat is the main agent's to read.
//
//   node clock-hook.mjs [--every <ms>]     (default 600000; 0: no clock)
//
// The manager turns it on with a settings file passed to Claude at
// session start (see the Claude adapter); AGENT_MANAGER_CLOCK_STATE_DIR
// moves the stamps (tests), AGENT_MANAGER_CHAT_NOTICE_MS bounds the
// question to the manager (default 700).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const everyIdx = args.indexOf('--every');
const every = everyIdx >= 0 ? Number(args[everyIdx + 1]) : 600_000;

function clock(event) {
  if (!every || every <= 0) return null;
  const session = String(event.session_id ?? 'unknown');
  const dir = process.env.AGENT_MANAGER_CLOCK_STATE_DIR || os.tmpdir();
  const stamp = path.join(
    dir,
    `am-clock-${session.replace(/[^A-Za-z0-9_-]/g, '_')}`,
  );
  const now = Date.now();
  let last = 0;
  try {
    last = Number(fs.readFileSync(stamp, 'utf8')) || 0;
  } catch {
    /* first call of the session */
  }
  if (last && now - last < every) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(stamp, String(now));
  } catch {
    /* a stamp that cannot be kept means a clock every call; still correct */
  }
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  return `The time is ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} (${tz}).`;
}

async function chat(event) {
  const url = process.env.AGENT_MANAGER_URL;
  const token = process.env.AGENT_MANAGER_TOKEN;
  if (!url || !token || event.agent_id) return null;
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/chat/notice`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(
        Number(process.env.AGENT_MANAGER_CHAT_NOTICE_MS) || 700,
      ),
    });
    if (!res.ok) return null;
    const text = (await res.json())?.text;
    return typeof text === 'string' && text ? text : null;
  } catch {
    return null; // the manager is away, restarting or slow: nothing to say
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', async () => {
  let event = {};
  try {
    event = JSON.parse(input) ?? {};
  } catch {
    /* no event: still answer, with a stamp per process */
  }
  const said = [clock(event), await chat(event)].filter(Boolean);
  if (!said.length) process.exit(0); // not waiting on a kept-alive socket
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: said.join('\n'),
      },
    }),
    () => process.exit(0),
  );
});
