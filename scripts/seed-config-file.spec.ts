import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The installer's seeding rule, driven directly. It decides what happens
 * to an operator's file on every deploy, it had run only inside a script
 * that builds and restarts a service, and it was the one part of the
 * harness/models/method work with no test at all.
 */
const SCRIPT = path.resolve(import.meta.dirname, 'seed-config-file.sh');

/** Runs the function as the installer does, and returns what it printed. */
function seed(
  what: string,
  src: string,
  target: string,
  installDir = '',
): string {
  return execFileSync(
    'bash',
    [
      '-c',
      `. "$1"; seed_config_file "$2" "$3" "$4" "$5"`,
      'bash',
      SCRIPT,
      what,
      src,
      target,
      installDir,
    ],
    { encoding: 'utf8' },
  ).trim();
}

describe('seed_config_file', () => {
  let dir: string;
  let shipped: string;
  let installed: string;
  let target: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-seed-'));
    shipped = path.join(dir, 'ship', 'models.md');
    installed = path.join(dir, 'install');
    target = path.join(dir, 'config', 'models.md');
    fs.mkdirSync(path.dirname(shipped), { recursive: true });
    fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(shipped, 'new text\n');
  });

  it('seeds when there is no copy, making the directory', () => {
    const said = seed('models file', shipped, target, installed);
    expect(said).toBe(`models file seeded at ${target}`);
    expect(fs.readFileSync(target, 'utf8')).toBe('new text\n');
  });

  it('says nothing when the copy is already the shipped text', () => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'new text\n');
    expect(seed('models file', shipped, target, installed)).toBe('');
  });

  it('updates a copy that is still the previously shipped text', () => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'old text\n'); // untouched since the last deploy
    fs.writeFileSync(path.join(installed, 'models.md'), 'old text\n');
    const said = seed('models file', shipped, target, installed);
    expect(said).toContain('updated');
    expect(said).toContain('previously shipped text');
    expect(fs.readFileSync(target, 'utf8')).toBe('new text\n');
  });

  it('keeps an edited copy and says so', () => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'the operator wrote this\n');
    fs.writeFileSync(path.join(installed, 'models.md'), 'old text\n');
    const said = seed('models file', shipped, target, installed);
    expect(said).toContain('is edited; kept');
    expect(fs.readFileSync(target, 'utf8')).toBe('the operator wrote this\n');
  });

  it('keeps a copy it cannot vouch for: no install directory to compare with', () => {
    // a first install over a config file of unknown provenance
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'old text\n');
    expect(seed('models file', shipped, target, '')).toContain('is edited');
    expect(fs.readFileSync(target, 'utf8')).toBe('old text\n');
  });

  it('treats each file on its own: the method does not follow the models file', () => {
    const method = path.join(dir, 'ship', 'method.md');
    const methodTarget = path.join(dir, 'config', 'method.md');
    fs.writeFileSync(method, 'the method\n');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'the operator wrote this\n');
    expect(seed('models file', shipped, target, installed)).toContain('kept');
    expect(seed('method', method, methodTarget, installed)).toContain('seeded');
    expect(fs.readFileSync(methodTarget, 'utf8')).toBe('the method\n');
  });
});
