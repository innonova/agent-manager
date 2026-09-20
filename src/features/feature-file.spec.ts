import { lastReport, parseFeature, serializeFeature } from './feature-file.js';

describe('frontmatter that is not YAML to the letter', () => {
  it('reads a title with a colon in it, as people write them', () => {
    const f = parseFeature(
      'ui-rethink',
      'ui',
      'ui/features/ui-rethink.md',
      '---\ntitle: the UI as a reading app: hierarchy, one header line, projects first\nstatus: review\npriority: 30\ndependsOn: [a-thing, another]\n---\n\nBody.\n',
      1,
    );
    expect(f.title).toBe(
      'the UI as a reading app: hierarchy, one header line, projects first',
    );
    expect(f.status).toBe('review');
    expect(f.priority).toBe(30);
    expect(f.dependsOn).toEqual(['a-thing', 'another']);
  });
});

describe('feature files', () => {
  it('parses frontmatter with defaults and keeps unknown keys', () => {
    const f = parseFeature(
      'login',
      'app',
      'app/features/login.md',
      '---\ntitle: Login\nstatus: review\npriority: 2\ndependsOn: [users, db]\nowner: anders\n---\n\n# Login\n\nAdd a login page.\n',
      5,
    );
    expect(f).toMatchObject({
      slug: 'login',
      repo: 'app',
      title: 'Login',
      status: 'review',
      priority: 2,
      dependsOn: ['users', 'db'],
      extra: { owner: 'anders' },
      mtime: 5,
    });
    expect(f.body).toBe('# Login\n\nAdd a login page.\n');
  });

  it('falls back to the first heading, planned and priority 100', () => {
    const f = parseFeature(
      'x',
      'app',
      'app/features/x.md',
      '# Something\n\nbody',
      1,
    );
    expect(f).toMatchObject({
      title: 'Something',
      status: 'planned',
      priority: 100,
      dependsOn: [],
    });
    expect(
      parseFeature(
        'y',
        'app',
        'p',
        '---\nstatus: nonsense\npriority: abc\n---\nno heading',
        1,
      ),
    ).toMatchObject({ title: 'y', status: 'planned', priority: 100 });
  });

  it('round-trips through serialize', () => {
    const text = serializeFeature({
      title: 'T',
      status: 'done',
      priority: 1,
      dependsOn: ['a'],
      body: 'Body text.',
      extra: { owner: 'x' },
    });
    expect(text).toBe(
      '---\ntitle: T\nstatus: done\npriority: 1\ndependsOn:\n  - a\nowner: x\n---\n\nBody text.\n',
    );
    expect(parseFeature('t', 'app', 'p', text, 0)).toMatchObject({
      title: 'T',
      status: 'done',
      priority: 1,
      dependsOn: ['a'],
      body: 'Body text.\n',
      extra: { owner: 'x' },
    });
  });

  it('keeps keys from the first version (profile, a queued status) without meaning', () => {
    const f = parseFeature(
      'old',
      'app',
      'p',
      '---\ntitle: Old\nstatus: queued\nprofile: claude\n---\n\nbody\n',
      0,
    );
    expect(f).toMatchObject({
      status: 'planned',
      extra: { profile: 'claude' },
    });
    expect(serializeFeature(f)).toContain('profile: claude');
  });

  it('takes the last report, heading included, and stops at the next section', () => {
    const body = [
      'The spec.',
      '',
      '## Report (2026-09-18)',
      '',
      'First round.',
      '',
      '## Response (2026-09-19)',
      '',
      'Do more.',
      '',
      '## Report (2026-09-20)',
      '',
      'Second round. Tests pass.',
      '',
    ].join('\n');
    expect(lastReport(body)).toBe(
      '## Report (2026-09-20)\n\nSecond round. Tests pass.',
    );
    // a report still being written, with nothing after it, and none at all
    expect(lastReport('## Report (2026-09-20)\n\nWorking.')).toContain(
      'Working.',
    );
    expect(lastReport('Just a spec.')).toBeNull();
  });
});
