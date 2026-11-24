import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exposeFollowerStore } from '../scripts/browser/exporter-instrumentation.ts';

test('only exposes the expected exporter task singleton and rejects unknown bundles', () => {
  const source = '799:function(t,n,r){n.default=new class t{initLoad(){} fetchFollowList(){}}}';
  const result = exposeFollowerStore(source);
  assert.match(result, /n\.default=globalThis\.__followerStore=new class/);
  assert.throws(() => exposeFollowerStore('another version'), /接口不兼容/);
  assert.throws(() => exposeFollowerStore(source + source), /接口不兼容/);
});
