#!/usr/bin/env node
// A Claude Code SessionStart hook for the `compact` source: after a
// compaction, the agent's dialog with the person is handed back to it.
// With `--on start` it is the hook for the `startup` source, a
// conversation that begins: the manager answers that one with text only
// when the conversation replaces one whose record the vendor no longer
// has, which is the other way an agent loses what was said.
//
// The manager keeps the dialog (the transcript and the chat) and
// decides what goes back; this script asks it, with the session's own
// AGENT_MANAGER_URL and AGENT_MANAGER_TOKEN, and prints what it says:
// a short notice naming the files the dialog was written to. Claude
// Code adds a hook's output to the agent's context and caps it at
// 10,000 characters, which is why the dialog itself is in files.
//
// The manager may be finishing the dialog's weighing, so the question
// can take a while (AGENT_MANAGER_HANDBACK_MS, default 170 s; the hook's
// own timeout in the settings file is a little longer). A manager that
// is away means silence: the agent carries on with its summary, as it
// did before there was a hook.
//
// The manager turns it on with the settings file it passes to Claude at
// session start (see `claudeSettingsFile`).
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', async () => {
  let event = {};
  try {
    event = JSON.parse(input) ?? {};
  } catch {
    /* no event: ask anyway */
  }
  const at = process.argv.indexOf('--on');
  const on = at >= 0 ? process.argv[at + 1] : undefined;
  const url = process.env.AGENT_MANAGER_URL;
  const token = process.env.AGENT_MANAGER_TOKEN;
  // a subagent's context is its own; the dialog is the main agent's
  if (!url || !token || event.agent_id) return;
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/dialog/handback`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(on ? { on } : {}),
      signal: AbortSignal.timeout(
        Number(process.env.AGENT_MANAGER_HANDBACK_MS) || 170_000,
      ),
    });
    if (!res.ok) return;
    const text = (await res.json())?.text;
    if (typeof text === 'string' && text) process.stdout.write(`${text}\n`);
  } catch {
    /* the manager is away or slow: nothing to hand back */
  }
});
