import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workspacePath, writeWorkspace } from './workspace.js';

describe('workspace file', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  });

  it('lives beside the repositories, named after the project', () => {
    const repos = [
      { name: 'a', path: path.join(dir, 'a') },
      { name: 'b', path: path.join(dir, 'b') },
    ];
    expect(workspacePath('My Project', repos)).toBe(
      path.join(dir, 'My Project.code-workspace'),
    );
    expect(workspacePath('odd/name', repos)).toBe(
      path.join(dir, 'odd-name.code-workspace'),
    );
  });

  it('writes the folders, keeps what else is in the file, and leaves it alone when nothing changed or it is not JSON', () => {
    const repos = [
      { name: 'a', path: path.join(dir, 'a') },
      { name: 'b', path: path.join(dir, 'b') },
    ];
    const first = writeWorkspace('p', repos);
    expect(first.result).toBe('written');
    const file = first.file;
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      folders: [
        { name: 'a', path: path.join(dir, 'a') },
        { name: 'b', path: path.join(dir, 'b') },
      ],
    });
    expect(writeWorkspace('p', repos).result).toBe('unchanged');
    // a person's settings survive a change of repositories
    fs.writeFileSync(
      file,
      JSON.stringify({
        folders: [],
        settings: { 'editor.tabSize': 2 },
        extensions: { recommendations: ['x'] },
      }),
    );
    expect(writeWorkspace('p', repos.slice(0, 1)).result).toBe('written');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      folders: [{ name: 'a', path: path.join(dir, 'a') }],
      settings: { 'editor.tabSize': 2 },
      extensions: { recommendations: ['x'] },
    });
    // not JSON (a comment, say): left as it is
    fs.writeFileSync(file, '// mine\n{ "folders": [] }\n');
    expect(writeWorkspace('p', repos).result).toBe('unparseable');
    expect(fs.readFileSync(file, 'utf8')).toBe('// mine\n{ "folders": [] }\n');
  });
});
