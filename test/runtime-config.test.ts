import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRuntimeConfig, saveRuntimeConfig, validateConfig } from '../src/runtime-config.ts';

test('TOML settings validate types, reject secrets and prevent lost updates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xbot-config-')); const path = join(dir, 'config.toml');
  try {
    const initial = readRuntimeConfig(path);
    const saved = saveRuntimeConfig({ ...initial.values, MIRROR_REQUEST_JITTER_MS: 0, FASHION_SEARCH_QUERIES: '时尚,"fashion"' }, initial.revision, path);
    assert.equal(saved.values.MIRROR_REQUEST_JITTER_MS, 0);
    assert.equal(saved.values.FASHION_SEARCH_QUERIES, '时尚,"fashion"');
    assert.throws(() => saveRuntimeConfig(saved.values, initial.revision, path), /重新加载/);
    const raw = readFileSync(path, 'utf8');
    assert.throws(() => saveRuntimeConfig({ PORT: -1 }, saved.revision, path), /范围/);
    assert.equal(readFileSync(path, 'utf8'), raw);
    assert.throws(() => validateConfig({ X_CLIENT_SECRET: 'secret' }), /不支持/);
    assert.throws(() => validateConfig({ X_AUTO_START_LOOP: 'false' }), /类型/);
    assert.throws(() => validateConfig({ MIRROR_POST_GAP_MIN_MS: 20000 }), /最大/);
    writeFileSync(path, '[runtime]\nPORT = nope');
    assert.throws(() => readRuntimeConfig(path));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
