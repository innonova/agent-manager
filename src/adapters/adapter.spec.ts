import { toolActivityDetail } from './adapter.js';

describe('toolActivityDetail', () => {
  it('takes a shell command, trimmed to its first line and ~80 chars', () => {
    expect(toolActivityDetail('Bash', { command: 'ls -la' })).toBe('ls -la');
    expect(toolActivityDetail('Bash', { command: 'echo one\necho two' })).toBe(
      'echo one',
    );
    const long = 'a'.repeat(120);
    const detail = toolActivityDetail('Bash', { command: long });
    expect(detail).toBe(`${'a'.repeat(80)}…`);
  });

  it('takes a read or edit path over the tool name', () => {
    expect(toolActivityDetail('Read', { file_path: '/tmp/x.txt' })).toBe(
      '/tmp/x.txt',
    );
    expect(toolActivityDetail('edit', { path: '/tmp/y.txt' })).toBe(
      '/tmp/y.txt',
    );
  });

  it('falls back to the tool name for anything else', () => {
    expect(toolActivityDetail('WebSearch', { query: 'x' })).toBe('WebSearch');
    expect(toolActivityDetail('apply_patch', '*** patch ***')).toBe(
      'apply_patch',
    );
    expect(toolActivityDetail('Task', null)).toBe('Task');
  });
});
