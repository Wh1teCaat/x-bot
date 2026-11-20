import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { XApiCircuit, retryAfterMs, rateLimitDelay } from '../src/x-api-circuit.ts';

test('429 opens a persistent endpoint circuit and allows only one half-open request', () => {
  const db = new DatabaseSync(':memory:');
  try {
    let now = 1000;
    const circuit = new XApiCircuit(db, () => now);
    const first = circuit.key('/2/users/11/following', 'POST', 'Bearer secret');
    assert.equal(first.includes('secret'), false);
    assert.equal(first, circuit.key('/2/users/22/following?x=1', 'POST', 'Bearer secret'));
    assert.notEqual(first, circuit.key('/2/users/22/following', 'POST', 'Bearer other'));
    assert.equal(circuit.allow(first), true);
    circuit.failure(first, 429, 20 * 60_000);
    assert.equal(new XApiCircuit(db, () => now).allow(first), false);
    now += 20 * 60_000;
    assert.equal(circuit.allow(first), true);
    assert.equal(circuit.allow(first), false);
    circuit.success(first);
    assert.equal(circuit.allow(first), true);
    assert.equal(retryAfterMs('30', now), 30_000);
    assert.equal(rateLimitDelay(new Headers({ 'retry-after': '30', 'x-rate-limit-reset': '1800' }), 1_000_000), 800_000);
  } finally { db.close(); }
});

test('transient API errors open after three failures and rejected half-open stays open', () => {
  const db = new DatabaseSync(':memory:');
  try {
    let now = 0; const circuit = new XApiCircuit(db, () => now);
    for (let n = 0; n < 3; n++) { assert.equal(circuit.allow('scope'), true); circuit.failure('scope', 503); }
    assert.equal(circuit.allow('scope'), false);
    now = 15 * 60_000;
    assert.equal(circuit.allow('scope'), true);
    circuit.reject('scope');
    assert.equal(circuit.allow('scope'), false);
  } finally { db.close(); }
});
