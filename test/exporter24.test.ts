/** 验证 exporter24 扩展页读取计数及未安装时的回退。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openExporter24, readExporter24Counts } from '../scripts/browser/exporter24.ts';

test('reads the two counts from the exporter24 result card', async () => {
  const page = {
    bringToFront: async () => {},
    locator: () => ({ first: () => ({ fill: async () => {}, press: async () => {} }) }),
    getByText: (pattern: RegExp) => ({ first: () => (
      pattern.source.includes('alice')
        ? { waitFor: async () => {} }
        : { innerText: async () => '' }
    ) }),
    getByRole: (_role: string, options: { name: RegExp }) => ({
      first: () => ({
        waitFor: async () => {},
        innerText: async () => options.name.source.includes('Followers') ? 'Followers: 80.5K' : 'Following: 90',
      }),
    }),
  };
  assert.deepEqual(await readExporter24Counts(page as any, 'alice'), { followers: 80500, following: 90 });
});

test('returns null when the extension page cannot be opened', async () => {
  const context = {
    newPage: async () => ({
      goto: async () => { throw new Error('extension not installed'); },
      close: async () => {},
    }),
  };
  assert.equal(await openExporter24(context as any), null);
});
