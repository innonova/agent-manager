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
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(
      lines.slice(0, 2).join('\n') + '\n',
    );
    // nothing matching: untouched
    expect(withdrawLastPrompt(file, 'never sent')).toEqual({
      removed: 0,
      kept: 2,
      promptsLeft: -1,
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(
      lines.slice(0, 2).join('\n') + '\n',
    );
  });
});
