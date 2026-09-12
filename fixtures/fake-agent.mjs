#!/usr/bin/env node
// A stand-in agent for development and tests. Speaks a tiny protocol that
// src/adapters/fake.adapter.ts understands. Never spends tokens.
//
// stdin:  {"type":"user","text":"..."}   {"type":"interrupt"}
// stdout: init, text_start/text_delta/text_end, thinking, tool_use, tool_result, result, error
//
// The text of a turn steers the script: "error" -> an error turn,
// "slow" -> a long turn, "tool" -> a tool call, "exit" -> the process exits,
// "permission" (with --ask) -> asks permission and waits for the answer,
// anything else -> a short streamed answer.
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const resumeIdx = process.argv.indexOf('--resume');
const conversationId =
  resumeIdx >= 0 ? process.argv[resumeIdx + 1] : randomUUID();
let turns = 0;
let interrupted = false;
const ask = process.argv.includes('--ask');
/** Resolvers for permission answers, by request id. */
const awaiting = new Map();

out({ type: 'init', conversationId, resumed: resumeIdx >= 0 });

async function stream(text, delay = 15) {
  out({ type: 'text_start' });
  for (const word of text.split(' ')) {
    if (interrupted) break;
    out({ type: 'text_delta', text: word + ' ' });
    await sleep(delay);
  }
  out({ type: 'text_end' });
}

async function handle(text) {
  turns++;
  const t0 = Date.now();
  interrupted = false;
  if (text.includes('error')) {
    await stream('Let me try that.');
    out({ type: 'error', message: "You've hit your usage limit (fake)." });
    return;
  }
  if (text.includes('block stdin')) {
    // stop reading stdin for good before reporting, so the daemon's next
    // large write is guaranteed to block
    rl.pause();
    process.stdin.pause();
    setInterval(() => {}, 1000);
    out({ type: 'result', durationMs: 1 });
    return;
  }
  if (text.includes('permission') && ask) {
    const id = `perm_${turns}`;
    out({
      type: 'permission_request',
      id,
      tool: 'Bash',
      title: 'Remove the build directory',
      input: { command: 'rm -rf dist' },
    });
    const decision = await new Promise((resolve) => awaiting.set(id, resolve));
    await stream(
      decision === 'deny'
        ? 'Understood, not removing it.'
        : `Removed it (${decision}).`,
    );
    out({ type: 'result', durationMs: Date.now() - t0 });
    return;
  }
  if (text.includes('tool')) {
    out({ type: 'thinking', text: 'I should look at the file first.' });
    const id = `toolu_${turns}`;
    out({
      type: 'tool_use',
      id,
      name: 'Read',
      input: { file_path: '/tmp/example.txt' },
    });
    await sleep(50);
    out({
      type: 'tool_result',
      id,
      output: 'line one\nline two',
      isError: false,
    });
  }
  await stream(
    text.includes('slow')
      ? 'This is a deliberately slow answer that streams word by word so the user interface can be seen updating. '.repeat(
          3,
        )
      : `You said: ${text}. Turn ${turns} done.`,
    text.includes('slow') ? 60 : 15,
  );
  out({ type: 'result', durationMs: Date.now() - t0 });
  if (text.includes('exit')) {
    // answer first, then leave: "please exit" is quick, "slow then exit" streams first
    await sleep(20);
    process.exit(0);
  }
}

const rl = readline.createInterface({ input: process.stdin });
let chain = Promise.resolve();
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === 'interrupt') {
    interrupted = true;
    return;
  }
  if (msg.type === 'permission_response') {
    awaiting.get(String(msg.id))?.(String(msg.decision));
    awaiting.delete(String(msg.id));
    return;
  }
  if (msg.type === 'user') chain = chain.then(() => handle(String(msg.text)));
});
rl.on('close', () => process.exit(0));
