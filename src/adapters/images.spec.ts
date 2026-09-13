import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from './claude.adapter.js';
import { CodexAdapter } from './codex.adapter.js';
import { CopilotAdapter } from './copilot.adapter.js';
import { FakeAdapter } from './fake.adapter.js';
import { loadFixture, replay } from './replay-harness.js';
import type { Item } from './adapter.js';

const png = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };
const rec = (s: 'in' | 'out', d: unknown, seq: number) => ({
  seq,
  t: 0,
  s,
  d: JSON.stringify(d),
});
const userItems = (ops: { item: Item }[] | undefined) =>
  (ops ?? []).map((o) => o.item).filter((i) => i.kind === 'user');

/** Each adapter sends an image in its vendor's shape and reads it back from the log as part of the user item. */
describe('images with a turn', () => {
  it('claude: an image block beside the text; the echoed message carries it', () => {
    const a = new ClaudeAdapter();
    const [line] = a.turn('see this', [png]) as any[];
    expect(line.message.content).toEqual([
      { type: 'text', text: 'see this' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'iVBORw0KGgo=',
        },
      },
    ]);
    expect((a.turn('plain') as any[])[0].message.content).toBe('plain'); // no images: the plain string as before
    // the user item comes from the logged input line (the echoed output is ignored)
    const echoed = a.ingest(rec('in', line, 1));
    expect(userItems(echoed.ops as any)).toEqual([
      { kind: 'user', text: 'see this', images: [png] },
    ]);
  });

  it('codex: a data url in the input; the logged turn/start gives it back', () => {
    const a = new CodexAdapter();
    a.startLines({ cwd: '/w', resume: null });
    replay(a, loadFixture('codex', 'tool-and-text.ndjson'));
    const [turn] = a.turn('see this', [png]) as any[];
    expect(turn.params.input).toEqual([
      { type: 'text', text: 'see this' },
      { type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=' },
    ]);
    const logged = a.ingest(rec('in', turn, 500));
    expect(userItems(logged.ops as any)).toEqual([
      { kind: 'user', text: 'see this', images: [png] },
    ]);
  });

  it('copilot: an ACP image block; the logged prompt gives it back', () => {
    const a = new CopilotAdapter();
    replay(a, loadFixture('copilot', 'tool-and-text.ndjson'));
    const [prompt] = a.turn('see this', [png]) as any[];
    expect(prompt.params.prompt).toEqual([
      { type: 'text', text: 'see this' },
      { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
    ]);
    const logged = a.ingest(rec('in', prompt, 500));
    expect(userItems(logged.ops as any)).toEqual([
      { kind: 'user', text: 'see this', images: [png] },
    ]);
  });

  it('fake: images ride in the line', () => {
    const a = new FakeAdapter();
    const [line] = a.turn('see this', [png]) as any[];
    expect(line.images).toEqual([png]);
    expect(userItems(a.ingest(rec('in', line, 1)).ops as any)).toEqual([
      { kind: 'user', text: 'see this', images: [png] },
    ]);
  });
});
