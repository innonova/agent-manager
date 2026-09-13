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
/** A turn is being handled; a user line arriving now steers it instead of starting another. */
let inFlight = false;
const steers = [];
const ask = process.argv.includes('--ask');
/** Resolvers for permission answers, by request id. */
const awaiting = new Map();

const modelIdx = process.argv.indexOf('--model');
const model = modelIdx >= 0 ? process.argv[modelIdx + 1] : 'fake-1';
out({ type: 'init', conversationId, resumed: resumeIdx >= 0, model });

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
  inFlight = true;
  try {
    await turn(text);
  } finally {
    inFlight = false;
    steers.length = 0;
  }
}

/** Ends a turn: notes anything steered in meanwhile, then the result. */
async function finish(t0) {
  while (steers.length) {
    const batch = steers.splice(0); // more may arrive while this streams
    await stream(`Also noted: ${batch.join(' / ')}.`, 15);
  }
  out({ type: 'result', durationMs: Date.now() - t0 });
}

async function turn(text) {
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
  if (text.includes('background')) {
    // a job left running: reported as pending, and reported done when asked
    if (text.includes('pending') || text.includes('check')) {
      out({ type: 'background', count: 0 });
      await stream('The background job had finished; picking up the result.');
    } else {
      out({ type: 'background', count: 1 });
      await stream('Started a background job.');
    }
    await finish(t0);
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
  await finish(t0);
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
  if (msg.type === 'user') {
    // images come along as base64; the fake only counts them
    const n = Array.isArray(msg.images) ? msg.images.length : 0;
    const text = n
      ? `${msg.text} [with ${n} image${n === 1 ? '' : 's'}]`
      : String(msg.text);
    if (inFlight) steers.push(text);
    else chain = chain.then(() => handle(text));
  }
});
rl.on('close', () => process.exit(0));
