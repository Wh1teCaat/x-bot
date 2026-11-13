/** 验证账号指纹的确定性与账号间差异。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprintFor } from "../scripts/browser/fingerprint.ts";

test("fingerprint is deterministic for the same account", () => {
  assert.deepEqual(fingerprintFor("2117822260593721344"), fingerprintFor("2117822260593721344"));
});

test("different accounts get distinct fingerprints", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) seen.add(JSON.stringify(fingerprintFor(`account-${i}`)));
  assert.ok(seen.size > 1);
});

test("fingerprint fields are within expected ranges", () => {
  const fp = fingerprintFor("2117822260593721344");
  assert.ok(fp.locale);
  assert.ok(fp.timezoneId);
  assert.ok(fp.viewport.width > 0 && fp.viewport.height > 0);
  assert.ok(fp.screen.width >= fp.viewport.width && fp.screen.height >= fp.viewport.height);
  assert.ok(['light', 'dark'].includes(fp.colorScheme));
  assert.ok(fp.acceptLanguage.includes(fp.locale.split('-')[0]));
});
