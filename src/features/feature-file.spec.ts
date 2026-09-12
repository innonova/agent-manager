import { parseFeature, serializeFeature } from './feature-file.js';

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
});
