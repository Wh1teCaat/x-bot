import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureCommentCratePermission } from '../scripts/browser/commentcrate-permission.ts';

test('keeps a granted permission unchanged', async () => {
  let calls = 0;
  const page = { evaluate: async () => { calls++; return true; } };
  await ensureCommentCratePermission(page as any);
  assert.equal(calls, 1);
});

test('does not attempt an interactive permission request in headless mode', async () => {
  const page = { evaluate: async () => false };
  await assert.rejects(ensureCommentCratePermission(page as any, { headless: true }), /关闭 X_HEADLESS/);
});

test('waits for the user to grant permission and gives actionable timeout', async () => {
  let evals = 0, brought = false;
  const page = { evaluate: async () => { evals++; return false; }, bringToFront: async () => { brought = true; }, waitForFunction: async () => { throw new Error('timeout'); } };
  await assert.rejects(ensureCommentCratePermission(page as any, { timeoutMs: 1 }), /授权未完成/);
  assert.equal(evals, 2);
  assert.equal(brought, true);
});
