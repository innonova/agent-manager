import type { Item } from '../adapters/adapter.js';

/**
 * The dialog between the people and one agent, as exchanges: what a
 * person wrote and what the agent wrote back until a person wrote
 * again. It is what the two settled together, both sides of it: the
 * agent's answers were read, and what was not disputed is agreed. So
 * nothing here paraphrases; an exchange is used whole or not at all.
 *
 * Pure functions: the service reads the transcript and the chat and
 * runs the classifier; this file says what an exchange is, which ones
 * go back to the agent after a compaction, and how they are written.
 */

/** A transcript item with what this file needs of its envelope. */
export interface DialogItem {
  index: number;
  at: number;
  item: Item;
}

/** A chat message with what this file needs of it. */
export interface DialogChat {
  at: number;
  from: 'agent' | 'person';
  author: string;
  kind: string;
  text: string;
  /** How a person's message travelled; `turn` and `steer` are in the transcript already. */
  via: string | null;
}

export interface Exchange {
  /** Its number: the order in the agent's history, the same after any number of compactions. */
  n: number;
  /** When the person wrote, unix ms. */
  at: number;
  /** Who wrote: a person's name, `agent-<name>` for another agent. */
  by: string;
  person: string;
  /** What the agent wrote back, its short progress lines left out. */
  agent: string;
  /** Taken back since: out of the agent's memory by the person's choice, so never handed back. */
  withdrawn: boolean;
}

export type WeightKind = 'purpose' | 'rule' | 'decision' | 'task' | 'chatter';

/** What the classifier said of one exchange. */
export interface Weight {
  n: number;
  kind: WeightKind;
  /** 0 to 3: what the agent would lose without the exchange word for word. */
  weight: number;
  /** Still applies (a purpose, rule or decision), or still open (a task). */
  inForce: boolean;
  /** The later exchange that reversed it, when the classifier named one. */
  supersededBy: number | null;
  /** At most fifteen words: what the exchange settled or asked. */
  line: string;
}

/** Who the manager's own turns are written by; they are not dialog. */
const MANAGER = 'manager';
/** An agent's text shorter than this, with more text after it in the same turn, is a progress line. */
const PROGRESS_LINE = 300;

/** A message that is a command to the agent's CLI, not something said: nothing of it is dialog. */
const COMMAND =
  /^\/(compact|clear|context|cost|model|effort|status|help|config|memory|rewind|resume)(\s|$)/;

/** Tokens a text takes, near enough to budget with (measured on whole dialogs: 0.35 per character where it is mostly prose, 0.5 where paths and code are quoted a lot). */
export const tokensOf = (text: string): number => Math.ceil(text.length * 0.35);

export const exchangeTokens = (e: Exchange): number =>
  tokensOf(e.person) + tokensOf(e.agent) + 20;

/**
 * The exchanges of a transcript and its chat, in the order they
 * happened. A person's message opens one; two in a row with nothing
 * from the agent between them are one. The agent's side is its text
 * (not its tool calls; of a turn's short lines only the last, the rest
 * being progress notes) and what it wrote in the chat. The manager's
 * own turns (a background job's poke) open nothing: what the agent
 * writes after one still answers the person.
 */
export function exchangesOf(
  items: DialogItem[],
  chat: DialogChat[] = [],
): Exchange[] {
  // what a take-back removed: from each marker's `withdrawnFrom` up to the marker
  const withdrawn = new Set<number>();
  for (const s of items) {
    const it = s.item;
    if (it.kind !== 'system' || it.withdrawnFrom === undefined) continue;
    for (const t of items)
      if (t.index >= it.withdrawnFrom && t.index < s.index)
        withdrawn.add(t.index);
  }
  type Said =
    | { at: number; who: 'person'; by: string; text: string; gone: boolean }
    | {
        at: number;
        who: 'agent';
        text: string;
        chat: boolean;
        /** The last text of its turn: what the person was left with, however short. */
        final: boolean;
      };
  const said: Said[] = [];
  let lastText: Extract<Said, { who: 'agent' }> | null = null;
  for (const s of items) {
    const it = s.item;
    // a turn's end, or the person writing: what the agent said last before it is what they were left with
    if ((it.kind === 'turn_end' || it.kind === 'user') && lastText) {
      lastText.final = true;
      lastText = null;
    }
    if (it.kind === 'user') {
      if (it.by === MANAGER || COMMAND.test(it.text.trim())) continue;
      const images = it.images?.length
        ? `\n[${it.images.length} image${it.images.length === 1 ? '' : 's'}]`
        : '';
      const text = `${it.text.trim()}${images}`;
      if (!text) continue;
      said.push({
        at: s.at,
        who: 'person',
        by: it.by ?? 'person',
        text,
        gone: withdrawn.has(s.index),
      });
    } else if (it.kind === 'text' && !it.streaming) {
      if (withdrawn.has(s.index) || !it.text.trim()) continue;
      lastText = {
        at: s.at,
        who: 'agent',
        text: it.text.trim(),
        chat: false,
        final: false,
      };
      said.push(lastText);
    }
  }
  if (lastText) lastText.final = true; // a turn still under way: its latest text is the latest there is
  for (const m of chat) {
    const text = m.text.trim();
    if (!text) continue;
    if (m.from === 'agent')
      said.push({
        at: m.at,
        who: 'agent',
        text: `[in the chat${m.kind === 'message' ? '' : `, a ${m.kind}`}] ${text}`,
        chat: true,
        final: true,
      });
    // a turn or a steer from the chat pane is a transcript item already
    else if (m.via !== 'turn' && m.via !== 'steer')
      said.push({
        at: m.at,
        who: 'person',
        by: m.author,
        text: `[in the chat] ${text}`,
        gone: false,
      });
  }
  // both lists are in time order; a stable sort keeps each one's own order
  said.sort((a, b) => a.at - b.at);

  const out: Exchange[] = [];
  let agentParts: Extract<Said, { who: 'agent' }>[] = [];
  const close = () => {
    const e = out[out.length - 1];
    if (!e) return;
    e.agent = agentParts
      .filter((p) => p.final || p.text.length >= PROGRESS_LINE)
      .map((p) => p.text)
      .join('\n\n');
  };
  for (const s of said) {
    if (s.who === 'agent') {
      if (out.length && !out[out.length - 1]!.withdrawn) agentParts.push(s);
      continue;
    }
    const last = out[out.length - 1];
    if (last && !s.gone && !last.withdrawn && agentParts.length === 0) {
      last.person += `\n\n${s.text}`; // nothing came back in between: one exchange
      continue;
    }
    close();
    agentParts = [];
    out.push({
      n: out.length + 1,
      at: s.at,
      by: s.by,
      person: s.text,
      agent: '',
      withdrawn: s.gone,
    });
  }
  close();
  return out;
}

export interface Selection {
  /** The most recent exchanges, whole. */
  recent: Exchange[];
  /** Older exchanges that still matter, whole. */
  kept: Exchange[];
  /** Every other exchange: known to exist, one line each. */
  indexed: Exchange[];
  tokens: number;
}

/**
 * Which exchanges go back whole within a budget of tokens: the most
 * recent up to half of it (the last two whatever they cost), then
 * older ones the classifier weighed 2 or 3 and still in force, the
 * heaviest first and among equals the newest, as far as nine tenths of
 * the budget goes. The rest are index lines.
 */
export function select(
  exchanges: Exchange[],
  weights: Map<number, Weight>,
  budget: number,
): Selection {
  const live = exchanges.filter((e) => !e.withdrawn);
  const recent: Exchange[] = [];
  let used = 0;
  for (let i = live.length - 1; i >= 0; i--) {
    const cost = exchangeTokens(live[i]!);
    if (recent.length >= 2 && used + cost > budget * 0.5) break;
    recent.unshift(live[i]!);
    used += cost;
  }
  const older = live.slice(0, live.length - recent.length);
  const wanted = older
    .map((e) => ({ e, w: weights.get(e.n) }))
    .filter(
      (x): x is { e: Exchange; w: Weight } =>
        !!x.w && x.w.weight >= 2 && x.w.inForce && x.w.supersededBy === null,
    )
    .sort((a, b) => b.w.weight - a.w.weight || b.e.n - a.e.n);
  const keep = new Set<number>();
  for (const { e } of wanted) {
    const cost = exchangeTokens(e);
    if (used + cost > budget * 0.9) continue; // a smaller one further down may still fit
    keep.add(e.n);
    used += cost;
  }
  return {
    recent,
    kept: older.filter((e) => keep.has(e.n)),
    indexed: older.filter((e) => !keep.has(e.n)),
    tokens: used,
  };
}

const stamp = (at: number): string =>
  `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const firstWords = (text: string, n = 14): string => {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  return words.length > n ? `${words.slice(0, n).join(' ')}…` : words.join(' ');
};

/** One exchange as the agent reads it back: who and when, then both sides as they were written. */
export function renderExchange(e: Exchange): string {
  return [
    `### #${e.n} · ${stamp(e.at)}`,
    `${e.by}:`,
    e.person,
    '',
    'You:',
    e.agent || '(you wrote nothing back before the next message)',
  ].join('\n');
}

/** The index: a line per exchange that is not handed back whole; runs with nothing to keep are folded into one. */
export function renderIndex(
  indexed: Exchange[],
  weights: Map<number, Weight>,
): string[] {
  const lines: string[] = [];
  let nothing: number[] = [];
  const flush = () => {
    if (!nothing.length) return;
    const from = nothing[0]!;
    const to = nothing[nothing.length - 1]!;
    lines.push(
      `#${from}${to > from ? ` to #${to}` : ''}: nothing to keep (acknowledgements, status questions)`,
    );
    nothing = [];
  };
  for (const e of indexed) {
    const w = weights.get(e.n);
    if (w && w.kind === 'chatter' && w.weight === 0) {
      // a run is consecutive numbers only: a kept exchange in between ends it
      if (nothing.length && nothing[nothing.length - 1] !== e.n - 1) flush();
      nothing.push(e.n);
      continue;
    }
    flush();
    const day = new Date(e.at).toISOString().slice(0, 10);
    if (!w) {
      lines.push(`#${e.n} ${day} (not weighed yet) ${firstWords(e.person)}`);
      continue;
    }
    const state =
      w.supersededBy !== null
        ? ` (reversed by #${w.supersededBy})`
        : w.inForce
          ? ''
          : w.kind === 'task'
            ? ' (done)'
            : ' (no longer in force)';
    lines.push(`#${e.n} ${day} ${w.kind}: ${w.line}${state}`);
  }
  flush();
  return lines;
}

/** No file of the hand-back is longer than this, so one read takes it in. */
const FILE_CHARS = 60_000;

/**
 * The hand-back as the texts of its files: the index first, then the
 * older exchanges that still matter, then the most recent, each group
 * in the order it happened, so the later of two that disagree is read
 * later. Cut at exchange boundaries; an exchange longer than a file
 * has one to itself.
 */
export function renderFiles(
  sel: Selection,
  weights: Map<number, Weight>,
): string[] {
  const blocks: string[] = [];
  const index = renderIndex(sel.indexed, weights);
  if (index.length)
    blocks.push(
      [
        '## Every other exchange, one line each',
        '',
        '`am recall <number>` prints any of them in full.',
        '',
        ...index,
      ].join('\n'),
    );
  // a heading stays with the first exchange under it, whichever file that lands in
  const group = (heading: string, list: Exchange[]) =>
    list.forEach((e, i) =>
      blocks.push(`${i === 0 ? `${heading}\n\n` : ''}${renderExchange(e)}`),
    );
  group(
    '## Earlier exchanges that still govern the work, word for word',
    sel.kept,
  );
  group('## The most recent exchanges, word for word', sel.recent);
  const files: string[] = [];
  let cur = '';
  for (const b of blocks) {
    if (cur && cur.length + b.length + 2 > FILE_CHARS) {
      files.push(cur);
      cur = '';
    }
    cur += `${cur ? '\n\n' : ''}${b}`;
  }
  if (cur) files.push(cur);
  return files.map(
    (text, i) =>
      `# Your dialog with the person, handed back after a compaction (file ${i + 1} of ${files.length})\n\n${text}\n`,
  );
}

/** What the hook says to the agent: short, since Claude Code caps a hook's text at 10,000 characters. */
export function renderNotice(paths: string[], sel: Selection): string {
  const whole = sel.recent.length + sel.kept.length;
  return [
    'Your context was just replaced by a summary of itself. The manager keeps your dialog with the person outside your context, word for word, and hands it back in the files below. It is both sides: what you wrote to the person and they did not dispute is as settled as what they wrote, including reasons, caveats and offers of yours they have not answered. Where the summary and these files differ, the files are what was said.',
    '',
    `Read ${paths.length === 1 ? 'this file' : 'these files'} in full, in order, before you do anything else:`,
    ...paths,
    '',
    `${whole} exchange${whole === 1 ? '' : 's'} are there whole: the most recent ones, and earlier ones that still govern the work. ${sel.indexed.length ? `The other ${sel.indexed.length} are listed one line each; \`am recall <number>\` prints any of them in full, and \`am recall\` the whole list.` : ''} They are in the order they happened: where two disagree, the later one stands.`,
  ].join('\n');
}

/** What the classifier is told. The dialog follows it on the same input. */
export const CLASSIFIER_INSTRUCTIONS = `You read the complete dialog between a person and the coding agent they work with, over weeks, and judge each exchange for one purpose: the agent's context is periodically replaced by a summary, and afterwards a limited number of old exchanges can be handed back to it word for word. You decide which ones are worth that.

How the two work together matters for the judgement: the person writes a few thoughts, the agent answers with its reasoning and proposals, and the person reads the answer and objects to what they disagree with. An answer the person read and did not dispute is agreed. So the agent's answers carry decisions as much as the person's messages do.

Each exchange is one message from the person followed by what the agent wrote back. You see all of them, in order, so judge each with knowledge of what came later: a decision that a later exchange reversed is no longer in force; a task that was finished is closed.

For every exchange output exactly one line of JSON, in order, and nothing else (no prose, no code fence):
{"id": <number>, "kind": "<purpose|rule|decision|task|chatter>", "in_force": <true|false>, "weight": <0-3>, "superseded_by": <id or null>, "line": "<at most 15 words saying what this exchange settled or asked>"}

kind:
- purpose: what the project, or a major part of it, is for; how the person wants to work with agents in general; who the person is.
- rule: a standing rule or preference about how to work here that reaches beyond one task (what never to do, what needs no asking, how to test, how to write).
- decision: a decision about the product or its design, with its reasons: behaviour, naming, structure, a rejected alternative.
- task: an instruction for one piece of work and the report on it; a bug reported and fixed; an observation acted on.
- chatter: acknowledgements, status questions, orientation, anything with nothing to keep.

in_force: for purpose, rule and decision, whether it still applies at the end of the dialog. For task, whether it is still open at the end. For chatter, false.

superseded_by: the id of the later exchange that reversed or replaced what this one settled, when there is one; then in_force is false.

weight: what it would cost if the agent continuing this work did not have this exchange word for word, given that it does have the code, the documents in the repository and the git history:
3: it would likely act against something the person settled, or reopen an argument already had.
2: it would lose reasons or context it will probably need again.
1: little; the outcome is in the repository and the reasons are unlikely to matter again.
0: nothing.`;

/** A dialog longer than this many characters does not fit one call with room to answer (a 1M window, at up to half a token per character). */
export const CLASSIFIER_CHARS = 1_600_000;

/**
 * The exchanges one weighing can take: all of them while they fit, and
 * otherwise without the oldest ones an earlier weighing found light,
 * which keep the weight they have.
 */
export function fitClassifier(
  exchanges: Exchange[],
  weights: Map<number, Weight>,
  cap = CLASSIFIER_CHARS,
): Exchange[] {
  const live = exchanges.filter((e) => !e.withdrawn);
  const size = (e: Exchange) => e.person.length + e.agent.length + 80;
  let total = live.reduce((n, e) => n + size(e), 0);
  if (total <= cap) return live;
  const drop = new Set<number>();
  for (const e of live) {
    if (total <= cap) break;
    const w = weights.get(e.n);
    if (!w || w.weight > 1) continue;
    drop.add(e.n);
    total -= size(e);
  }
  if (total > cap)
    throw new Error(
      'the dialog is too long to weigh in one call, even without what was found light before',
    );
  return live.filter((e) => !drop.has(e.n));
}

/** The classifier's whole input: its instructions, then the exchanges to weigh. */
export function classifierInput(exchanges: Exchange[]): string {
  const live = exchanges.filter((e) => !e.withdrawn);
  return [
    CLASSIFIER_INSTRUCTIONS,
    '',
    `The dialog follows, ${live.length} exchanges. Output one JSON line per exchange, ${live.length} lines.`,
    '',
    ...live.map(
      (e) =>
        `=== exchange ${e.n} (${stamp(e.at)})\nPERSON (${e.by}):\n${e.person}\n\nAGENT:\n${e.agent || '(nothing written back before the next message)'}\n`,
    ),
  ].join('\n');
}

const KINDS: WeightKind[] = ['purpose', 'rule', 'decision', 'task', 'chatter'];

/**
 * The classifier's answer, read leniently: any line that is a JSON
 * object with a known exchange number counts, whatever surrounds it. A
 * line that says less than asked is completed with the careful value
 * (unknown kind: decision; no verdict on in force: still in force).
 */
export function parseWeights(text: string, known: Set<number>): Weight[] {
  const out = new Map<number, Weight>();
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/,$/, '');
    if (!line.startsWith('{')) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const n = Number(o.id);
    if (!Number.isInteger(n) || !known.has(n)) continue;
    const kind = KINDS.includes(o.kind as WeightKind)
      ? (o.kind as WeightKind)
      : 'decision';
    const weight = Math.max(0, Math.min(3, Math.round(Number(o.weight)) || 0));
    const sup = Number(o.superseded_by);
    const supersededBy =
      Number.isInteger(sup) && known.has(sup) && sup > n ? sup : null;
    out.set(n, {
      n,
      kind,
      weight,
      inForce:
        supersededBy === null &&
        (o.in_force === undefined ? kind !== 'chatter' : o.in_force === true),
      supersededBy,
      line: String(o.line ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200),
    });
  }
  return [...out.values()];
}
