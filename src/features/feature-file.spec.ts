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
      profile: null,
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
      profile: 'claude',
      dependsOn: ['a'],
      body: 'Body text.',
      extra: { owner: 'x' },
    });
    expect(text).toBe(
      '---\ntitle: T\nstatus: done\npriority: 1\nprofile: claude\ndependsOn:\n  - a\nowner: x\n---\n\nBody text.\n',
    );
    expect(parseFeature('t', 'app', 'p', text, 0)).toMatchObject({
      title: 'T',
      status: 'done',
      priority: 1,
      profile: 'claude',
      dependsOn: ['a'],
      body: 'Body text.\n',
      extra: { owner: 'x' },
    });
  });
});
