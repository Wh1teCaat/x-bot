import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XPageCircuit } from '../scripts/browser/x-page-circuit.ts';

test('X page 429 opens a persisted circuit while unrelated responses do not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'x-page-circuit-'));
  try {
    const file = join(dir, 'loop.sqlite');
    let listener: any;
    const context = { on: (_: string, callback: any) => { listener = callback; }, off: () => {} } as any;
    const circuit = new XPageCircuit(file); circuit.attach(context);
    listener({ url: () => 'https://exporter24.net/a', status: () => 429 });
    assert.equal(circuit.isBlocked(), false);
    listener({ url: () => 'https://x.com/a', status: () => 429 });
    assert.throws(() => circuit.guard(), /熔断/); circuit.close();
    const restored = new XPageCircuit(file); assert.equal(restored.isBlocked(), true); restored.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
