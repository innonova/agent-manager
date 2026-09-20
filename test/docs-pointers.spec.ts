import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * The method moved out of `docs/` to the repository root, where the
 * installer can ship it like the harness note and the models file. Every
 * pointer here has to follow, and a stale one is silent: the text still
 * reads, it just names a file nobody has.
 *
 * The old path is assembled rather than written, so that this file is not
 * itself a hit.
 */
const ROOT = path.resolve(import.meta.dirname, '..');

describe('documentation pointers', () => {
  it('nothing in the repository points at the old path of the method', () => {
    // git grep exits 1 when nothing matches, which is the passing case.
    // Feature files are excluded on purpose: they are the record of what
    // was said at the time, and their specs and reports are not edited.
    let hits = '';
    try {
      hits = execFileSync(
        'git',
        ['grep', '-l', '--', ['docs', 'method.md'].join('/'), ':!features/'],
        { cwd: ROOT, encoding: 'utf8' },
      ).trim();
    } catch (err) {
      if ((err as { status?: number }).status !== 1) throw err;
    }
    expect(hits).toBe('');
  });
});
