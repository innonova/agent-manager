import {
  escapeBody,
  headerOf,
  parseLearnings,
  renderEntry,
} from './learnings-file.js';

const at = new Date(2026, 8, 20, 11, 30).getTime(); // 2026-09-20 11:30, local

describe('the learnings file', () => {
  it('writes a header the manager owns, with and without a reference', () => {
    expect(headerOf(at, 'agent-claude', 'run 9ae50a37')).toBe(
      '## 2026-09-20 11:30 · agent-claude · run 9ae50a37',
    );
    expect(headerOf(at, 'anders', null)).toBe('## 2026-09-20 11:30 · anders');
  });

  it('reads back what it wrote, numbered from one, oldest first', () => {
    const file =
      renderEntry(at, 'anders', null, 'The first thing.') +
      '\n' +
      renderEntry(at + 60_000, 'agent-claude', 'feature runs', 'The second.');
    const entries = parseLearnings(file);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      n: 1,
      by: 'anders',
      ref: null,
      text: 'The first thing.',
    });
    expect(entries[1]).toMatchObject({
      n: 2,
      by: 'agent-claude',
      ref: 'feature runs',
      text: 'The second.',
    });
    expect(entries[1]!.at - entries[0]!.at).toBe(60_000);
  });

  it('keeps a paragraph whole, blank lines and all', () => {
    const text = 'One line.\n\nAnd another paragraph.\n- a list item';
    const [entry] = parseLearnings(renderEntry(at, 'me', null, text));
    expect(entry!.text).toBe(text);
  });

  it('does not let a body split itself into a second entry', () => {
    // the hazard of markdown as the store: the body and the index share
    // a syntax, and an author quoting a header is not rare
    const text =
      'The header format is:\n## 2026-09-20 11:30 · someone · run x\nwhich the parser must not read as an entry.';
    const file = renderEntry(at, 'me', null, text);
    const entries = parseLearnings(file);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toContain('2026-09-20 11:30');
    expect(entries[0]!.by).toBe('me');
  });

  it('leaves ordinary markdown in the body alone', () => {
    const text = '# A title\n## Not a header of ours\n### deeper\n#hash';
    expect(escapeBody(text)).toBe(text);
    const [entry] = parseLearnings(renderEntry(at, 'me', null, text));
    expect(entry!.text).toBe(text);
  });

  it('reads a file with a title above the first entry, an empty one, and CRLF', () => {
    expect(parseLearnings('')).toEqual([]);
    expect(parseLearnings('# Learnings\n\nsome preamble\n')).toEqual([]);
    const file = `# Learnings\n\n${renderEntry(at, 'me', null, 'Kept.')}`;
    expect(parseLearnings(file)).toHaveLength(1);
    expect(parseLearnings(file.replace(/\n/g, '\r\n'))[0]!.text).toBe('Kept.');
  });

  it('never lets a name or a reference break the header', () => {
    const header = headerOf(at, 'some·one\nodd', 'run\n1');
    expect(header.split('\n')).toHaveLength(1);
    const [entry] = parseLearnings(`${header}\n\nbody\n`);
    expect(entry!.by).toBe('some one odd');
    expect(entry!.ref).toBe('run 1');
  });
});
