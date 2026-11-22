import { featuresNamed } from './git.js';

describe('the features a commit message names', () => {
  it('reads every Feature: line, wherever in the message it stands', () => {
    // as an agent writes it: git's own parser sees only the last paragraph, the co-author
    expect(
      featuresNamed(
        'Add triple to lib\n\nExport triple beside double.\n\nFeature: triples/triple\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n',
      ),
    ).toEqual(['triples/triple']);
    // as git would have it: one block of trailers
    expect(
      featuresNamed(
        'subject\n\nFeature: a/one\nFeature:   b/two  \nCo-Authored-By: x <x@y.z>',
      ),
    ).toEqual(['a/one', 'b/two']);
    expect(featuresNamed('feature: lower/case')).toEqual(['lower/case']);
  });

  it('reads none where there is none', () => {
    expect(featuresNamed('subject\n\nThe feature: it works.')).toEqual([]);
    expect(featuresNamed('Feature:\n\nnothing after the colon')).toEqual([]);
    expect(featuresNamed('')).toEqual([]);
  });
});
