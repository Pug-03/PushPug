import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isNewer, parseVersion, parseRelease, repoSlug } from '../src/core/updates';

describe('update check', () => {
  test('versions compare by number, not text', () => {
    assert.equal(isNewer('1.0.10', '1.0.9'), true);
    assert.equal(isNewer('v1.1.0', '1.0.99'), true);
    assert.equal(isNewer('1.0.2', '1.0.2'), false);
    assert.equal(isNewer('1.0.1', '1.0.2'), false);
    assert.equal(isNewer('2.0.0-beta.1', '1.9.0'), true);
    assert.equal(isNewer('nightly', '1.0.0'), false);
    assert.deepEqual(parseVersion('v3.4.5'), [3, 4, 5]);
    assert.equal(parseVersion('1.2'), null);
  });

  test('repo slug from package.json repository url', () => {
    assert.equal(repoSlug('https://github.com/Pug-03/PushPug.git'), 'Pug-03/PushPug');
    assert.equal(repoSlug('git@github.com:Pug-03/PushPug.git'), 'Pug-03/PushPug');
    assert.equal(repoSlug('https://gitlab.com/a/b'), null);
    assert.equal(repoSlug(undefined), null);
  });

  test('reads the latest release and its .vsix', () => {
    const r = parseRelease({
      tag_name: 'v1.0.3',
      html_url: 'https://github.com/Pug-03/PushPug/releases/tag/v1.0.3',
      body: 'notes',
      assets: [
        { name: 'checksums.txt', browser_download_url: 'https://github.com/Pug-03/PushPug/releases/download/v1.0.3/checksums.txt' },
        { name: 'pushpug-1.0.3.vsix', browser_download_url: 'https://github.com/Pug-03/PushPug/releases/download/v1.0.3/pushpug-1.0.3.vsix' },
      ],
    });
    assert.equal(r?.version, '1.0.3');
    assert.equal(r?.vsixUrl, 'https://github.com/Pug-03/PushPug/releases/download/v1.0.3/pushpug-1.0.3.vsix');
  });

  test('ignores drafts, pre-releases, junk and non-GitHub downloads', () => {
    assert.equal(parseRelease({ tag_name: 'v2.0.0', html_url: 'x', draft: true }), null);
    assert.equal(parseRelease({ tag_name: 'v2.0.0', html_url: 'x', prerelease: true }), null);
    assert.equal(parseRelease({ tag_name: 'latest', html_url: 'x' }), null);
    assert.equal(parseRelease(null), null);
    const r = parseRelease({ tag_name: 'v2.0.0', html_url: 'x', assets: [{ name: 'a.vsix', browser_download_url: 'https://evil.example/a.vsix' }] });
    assert.equal(r?.vsixUrl, null);
  });
});
