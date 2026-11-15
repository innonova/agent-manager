import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { conversationFile, withdrawLastPrompt } from './claude-conversation.js';

const rec = (o: Record<string, unknown>) => JSON.stringify(o);

describe('claude conversation file', () => {
  it('is named after the working directory and the conversation', () => {
    expect(conversationFile('/home/u/projects/x', 'abc')).toBe(
      path.join(
        os.homedir(),
        '.claude',
        'projects',
        '-home-u-projects-x',
        'abc.jsonl',
      ),
    );
    expect(conversationFile('C:\\Users\\u\\x', 'abc')).toContain(
      path.join('C--Users-u-x', 'abc.jsonl'),
    );
  });

  it('cuts back to before the last prompt with that text, leaving tool results and earlier prompts', () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'conv-')),
      'c.jsonl',
    );
    const lines = [
      rec({
        type: 'user',
        message: { role: 'user', content: 'first' },
        uuid: '1',
      }),
      rec({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        uuid: '2',
      }),
      rec({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'oops wrong window' }],
        },
        uuid: '3',
      }),
      rec({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't' }],
        },
        uuid: '4',
      }),
      rec({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't' }],
        },
        uuid: '5',
      }),
      rec({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'that seems meant for someone else' },
          ],
        },
        uuid: '6',
      }),
    ];
    fs.writeFileSync(file, lines.join('\n') + '\n');
    expect(withdrawLastPrompt(file, 'oops wrong window')).toEqual({
      removed: 4,
      kept: 2,
      promptsLeft: 1,
      held: false,
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(
      lines.slice(0, 2).join('\n') + '\n',
    );
    // nothing matching: untouched
    expect(withdrawLastPrompt(file, 'never sent')).toEqual({
      removed: 0,
      kept: 2,
      promptsLeft: -1,
      held: false,
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(
      lines.slice(0, 2).join('\n') + '\n',
    );
  });
  it('a message taken during a turn is cut where Claude read it; the turn before it stays', () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'conv-')),
      'steered.jsonl',
    );
    const lines = [
      rec({
        type: 'user',
        message: { role: 'user', content: 'do the long thing' },
      }),
      rec({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't' }],
        },
      }),
      // held by Claude Code until the tool ended: not a prompt, and not where the agent read it
      rec({
        type: 'queue-operation',
        operation: 'enqueue',
        content: 'no, the other thing',
      }),
      rec({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't' }],
        },
      }),
      rec({
        type: 'attachment',
        attachment: { type: 'queued_command', prompt: 'no, the other thing' },
      }),
      rec({ type: 'attachment', attachment: { type: 'hook_success' } }),
      rec({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'the other thing, then' }],
        },
      }),
    ];
    fs.writeFileSync(file, lines.join('\n') + '\n');
    expect(withdrawLastPrompt(file, 'no, the other thing')).toEqual({
      removed: 3,
      kept: 4,
      promptsLeft: 1,
      held: false,
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(
      lines.slice(0, 4).join('\n') + '\n',
    );
  });
  it('a message sent during a turn that ended before the agent read it is found held: nothing to cut', () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'conv-')),
      'held.jsonl',
    );
    const lines = [
      rec({ type: 'queue-operation', operation: 'enqueue', content: 'do it' }),
      rec({ type: 'queue-operation', operation: 'dequeue' }),
      rec({ type: 'user', message: { role: 'user', content: 'do it' } }),
      rec({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't' }],
        },
      }),
      rec({
        type: 'queue-operation',
        operation: 'enqueue',
        content: 'nonsense',
      }),
      rec({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't' }],
        },
      }),
    ];
    fs.writeFileSync(file, lines.join('\n') + '\n');
    expect(withdrawLastPrompt(file, 'nonsense')).toEqual({
      removed: 0,
      kept: 6,
      promptsLeft: -1,
      held: true,
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(lines.join('\n') + '\n');
    // the turn's own message was read: its record is what is cut, not the one that held it first
    expect(withdrawLastPrompt(file, 'do it')).toMatchObject({
      removed: 4,
      held: false,
    });
  });
});
