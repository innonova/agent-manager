#!/usr/bin/env node
// A stand-in agent for development and tests. Speaks a tiny protocol that
// src/adapters/fake.adapter.ts understands. Never spends tokens.
//
// stdin:  {"type":"user","text":"..."}   {"type":"interrupt"}
// stdout: init, status, text_start/text_delta/text_end, thinking,
//         thinking_tokens, tool_use, tool_result, committed, result, error
//
// The text of a turn steers the script: "error" -> an error turn,
// "slow" -> a long turn, "tool" -> a tool call, "exit" -> the process exits,
// "permission" (with --ask) -> asks permission and waits for the answer,
// "commit" -> reports a commit, "linger" -> stays working until interrupted,
// anything else -> a short streamed answer.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const resumeIdx = process.argv.indexOf('--resume');
// a fork: a conversation of its own that begins as a copy of the one named
const forkOf =
  resumeIdx >= 0 && process.argv.includes('--fork-session')
    ? process.argv[resumeIdx + 1]
    : null;
const conversationId =
  resumeIdx >= 0 && !forkOf ? process.argv[resumeIdx + 1] : randomUUID();
/**
 * With `--conversations <dir>` it keeps its conversations on disk the way
 * Claude Code does, one file per conversation in a directory per working
 * directory, written from the first turn on; and like Claude Code it
 * refuses to resume or fork one whose file is not there. Without it the
 * fake remembers nothing and resumes anything, which lets a test pass
 * over a manager that lost a conversation.
 */
const convIdx = process.argv.indexOf('--conversations');
const conversations =
  convIdx >= 0
    ? path.join(process.argv[convIdx + 1], path.basename(process.cwd()))
    : null;
const fileOf = (id) => path.join(conversations, `${id}.jsonl`);
if (conversations && resumeIdx >= 0) {
  const wanted = process.argv[resumeIdx + 1];
  if (!fs.existsSync(fileOf(wanted))) {
    process.stderr.write(`No conversation found with session ID: ${wanted}\n`);
    process.exit(1);
  }
}
// A fork has read the conversation it begins as a copy of by the time it
// runs, as the real CLI has: the file it was read from may be gone by its
// first turn.
const inherited =
  conversations && forkOf ? fs.readFileSync(fileOf(forkOf), 'utf8') : '';
/** Its own record: begun as a copy of the one it was forked from, a line per turn after. */
function record(text) {
  if (!conversations) return;
  fs.mkdirSync(conversations, { recursive: true });
  if (forkOf && !fs.existsSync(fileOf(conversationId)))
    fs.writeFileSync(fileOf(conversationId), inherited);
  fs.appendFileSync(
    fileOf(conversationId),
    `${JSON.stringify({ user: text })}\n`,
  );
}
let turns = 0;
let interrupted = false;
/** The turn's output "tokens" so far: one per word streamed, reset per turn, reported like a vendor's running count. */
let turnTokens = 0;
/**
 * What this turn will bill, reported with the result and not before, as
 * every real vendor reports a turn's cost: Claude in `result`, Codex in
 * `turn/completed`. A fixture that billed at the start of the turn hid
 * the bug where a run closed before its cost existed.
 */
let pendingUsage = null;
/** A turn is being handled; a user line arriving now steers it instead of starting another. */
let inFlight = false;
const steers = [];
const ask = process.argv.includes('--ask');
/** Resolvers for permission answers, by request id. */
const awaiting = new Map();

const modelIdx = process.argv.indexOf('--model');
const model = modelIdx >= 0 ? process.argv[modelIdx + 1] : 'fake-1';
// the harness note, as a real CLI would take a system prompt; "note" repeats it
const noteIdx = process.argv.indexOf('--note');
const note = noteIdx >= 0 ? process.argv[noteIdx + 1] : '';
// Keeping its conversations on disk, it names a new one (a fresh start,
// a fork) when it is first spoken to and not before, as Claude Code does:
// until then there is no file, and nothing to resume by that name.
let named = !conversations || (resumeIdx >= 0 && !forkOf);
out({
  type: 'init',
  ...(named ? { conversationId } : {}),
  resumed: resumeIdx >= 0,
  model,
});

async function stream(text, delay = 15) {
  out({ type: 'text_start', tokens: turnTokens });
  for (const word of text.split(' ')) {
    if (interrupted) break;
    turnTokens++;
    out({ type: 'text_delta', text: word + ' ', tokens: turnTokens });
    await sleep(delay);
  }
  out({ type: 'text_end' });
}

async function handle(text) {
  inFlight = true;
  record(text);
  if (!named) {
    named = true;
    out({ type: 'init', conversationId, resumed: resumeIdx >= 0, model });
  }
  try {
    await turn(text);
  } finally {
    inFlight = false;
    steers.length = 0;
  }
}

/** What the turn cost, said with its result the way a vendor says it. */
function bill() {
  if (!pendingUsage) return;
  out(pendingUsage);
  pendingUsage = null;
}

/** Ends a turn: notes anything steered in meanwhile, the cost, then the result. */
async function finish(t0) {
  while (steers.length) {
    const batch = steers.splice(0); // more may arrive while this streams
    await stream(`Also noted: ${batch.join(' / ')}.`, 15);
  }
  bill();
  out({ type: 'result', durationMs: Date.now() - t0 });
}

async function turn(text) {
  turns++;
  const t0 = Date.now();
  interrupted = false;
  turnTokens = 0;
  pendingUsage = null;
  // every request to the model is out before anything comes back, as a
  // real CLI reports it
  out({ type: 'status', status: 'requesting' });
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
    bill();
    out({ type: 'result', durationMs: Date.now() - t0 });
    return;
  }
  if (text.includes('whence')) {
    // whether this conversation began as a copy of another, as a forked CLI session would know
    await stream(forkOf ? `Forked from ${forkOf}.` : 'Not a fork.', 0);
    await finish(t0);
    return;
  }
  if (text.includes('note')) {
    await stream(note ? `My note: ${note}` : 'I have no note.', 0); // the whole note, not word by word: it is long
    await finish(t0);
    return;
  }
  if (text.includes('token')) {
    // the manager's own way in, from the environment (tests read it here; a real agent gives it to `am`)
    await stream(
      `My manager: ${process.env.AGENT_MANAGER_URL ?? ''} token ${process.env.AGENT_MANAGER_TOKEN ?? ''}`,
    );
    await finish(t0);
    return;
  }
  if (text.includes('usage')) {
    // "usage 42": the account's rolling windows, as Claude and Codex
    // report theirs — with the result at the end of the turn, not now
    const n = Number(/usage\s+(\d+)/.exec(text)?.[1] ?? 42);
    pendingUsage = { type: 'usage', fiveHour: n, sevenDay: Math.round(n / 2) };
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
  if (text.includes('linger')) {
    // stays working for a while, so a test can watch something that takes
    // the manager a few seconds to notice; an interrupt cuts it short
    await stream('Working on it.');
    for (let i = 0; i < 100 && !interrupted; i++) await sleep(200);
    await finish(t0);
    return;
  }
  if (text.includes('commit')) {
    // work landing, as a real CLI announces it
    out({ type: 'committed', branch: 'main', cwd: process.cwd() });
    await stream('Committed that.');
    await finish(t0);
    return;
  }
  if (text.includes('tool')) {
    out({ type: 'thinking', text: 'I should look at the file first.' });
    // Held long enough for each activity (thinking, then tool) to outlast
    // the manager's one-announcement-per-second throttle on its own, so a
    // client watching the socket sees both rather than only the last;
    // the estimate ticks while it thinks, as a real CLI reports one.
    for (let estimate = 50; estimate <= 150; estimate += 50) {
      await sleep(500);
      out({ type: 'thinking_tokens', tokens: estimate });
    }
    const id = `toolu_${turns}`;
    out({
      type: 'tool_use',
      id,
      name: 'Read',
      input: { file_path: '/tmp/example.txt' },
    });
    await sleep(1500);
    out({
      type: 'tool_result',
      id,
      output: 'line one\nline two',
      isError: false,
    });
    out({ type: 'status', status: 'requesting' }); // the answer needs another request
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
