import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHandle, originalAvatarUrl, originalBannerUrl } from '../scripts/clone_user/core.ts';

test('accepts valid handles and rejects unsafe input', () => {
  assert.equal(parseHandle('@Brand_1'), 'Brand_1');
  for (const value of ['../bad', 'x/y', 'a'.repeat(16), '']) assert.throws(() => parseHandle(value));
});
test('accepts only the X avatar CDN and preserves the original image', () => {
  assert.equal(originalAvatarUrl('https://pbs.twimg.com/profile_images/123/foo_normal.jpg'), 'https://pbs.twimg.com/profile_images/123/foo.jpg');
  assert.equal(originalAvatarUrl('https://pbs.twimg.com/profile_images/123/foo_400x400.jpg'), 'https://pbs.twimg.com/profile_images/123/foo.jpg');
  assert.equal(originalAvatarUrl('https://pbs.twimg.com/profile_images/123/foo_200x200.jpg'), 'https://pbs.twimg.com/profile_images/123/foo.jpg');
  assert.throws(() => originalAvatarUrl('https://evil.example/profile_images/123/x.jpg'));
  assert.throws(() => originalAvatarUrl('http://pbs.twimg.com/profile_images/123/x.jpg'));
});

test('accepts only the X banner CDN and removes the display size', () => {
  assert.equal(originalBannerUrl('https://pbs.twimg.com/profile_banners/1/2/600x200'), 'https://pbs.twimg.com/profile_banners/1/2');
  assert.throws(() => originalBannerUrl('https://pbs.twimg.com/profile_images/1/2/600x200'));
  assert.throws(() => originalBannerUrl('https://evil.example/profile_banners/1/2'));
});
