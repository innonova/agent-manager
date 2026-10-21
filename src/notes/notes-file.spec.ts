import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  formatNote,
  parseNote,
  readNotes,
  splitText,
  writeNote,
} from './notes-file.js';

describe('note files', () => {
  it('parses the front matter and the text, title first', () => {
    const it = parseNote(
      'k3f9a',
      '---\ndate: 2026-10-21\ndone: false\n---\nshow the stats of the selected weapon\n\nIn the right panel.\n\nTwo paragraphs are fine.\n',
    );
    expect(it).toEqual({
      id: 'k3f9a',
      done: false,
      date: '2026-10-21',
      title: 'show the stats of the selected weapon',
      body: 'In the right panel.\n\nTwo paragraphs are fine.',
    });
    expect(formatNote(it)).toBe(
      '---\ndate: 2026-10-21\ndone: false\n---\nshow the stats of the selected weapon\n\nIn the right panel.\n\nTwo paragraphs are fine.\n',
    );
    // written by hand without front matter: still a note
    expect(parseNote('abcde', 'just a line\n')).toMatchObject({
      done: false,
      date: '',
      title: 'just a line',
      body: '',
    });
  });

  it('lists a directory open first, then by date; a missing directory is no notes', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-'));
    expect(await readNotes(repo)).toEqual([]);
    await writeNote(repo, {
      id: 'bbbbb',
      done: false,
      date: '2026-10-21',
      title: 'later',
      body: '',
    });
    await writeNote(repo, {
      id: 'aaaaa',
      done: true,
      date: '2026-10-20',
      title: 'done one',
      body: '',
    });
    await writeNote(repo, {
      id: 'ccccc',
      done: false,
      date: '2026-10-20',
      title: 'earlier',
      body: 'x',
    });
    fs.writeFileSync(path.join(repo, 'notes', 'README'), 'not a note');
    expect((await readNotes(repo)).map((i) => i.id)).toEqual([
      'ccccc',
      'bbbbb',
      'aaaaa',
    ]);
  });

  it('splits typed text into a title line and a body', () => {
    expect(splitText('just one line')).toEqual({
      title: 'just one line',
      body: '',
    });
    expect(splitText('first\n\nsecond\nthird\n')).toEqual({
      title: 'first',
      body: 'second\nthird',
    });
  });
});
