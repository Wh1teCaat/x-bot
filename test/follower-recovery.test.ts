import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { planFollowerRecovery, supersedeFollowerAttempts } from '../scripts/loop/follower-recovery.ts';

function setup() { const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE runs(id TEXT PRIMARY KEY,status TEXT,stage TEXT,state TEXT,pid INTEGER,updated_at TEXT,error TEXT)'); return db; }
function add(db: DatabaseSync, id: string, status = 'failed', stage = 'followers-export', changes: object = {}, account = '1') {
  const state = { version: 5, followerBatchMode: true, phase: 'followers', followAccountId: account, blogger: 'alice', ...changes };
  db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?)').run(id, status, stage, JSON.stringify(state), null, id, null);
}
test('resumes newest safe failed attempt and supersedes duplicates only after success', () => {
  const db = setup(); try {
    add(db, '001'); add(db, '002'); add(db, '003', 'failed', 'followers-export', {}, '2');
    assert.deepEqual(planFollowerRecovery(db, '1', 'Alice'), { kind: 'resume', id: '002', supersede: ['001'] });
    assert.equal((db.prepare('SELECT status FROM runs WHERE id=?').get('001') as any).status, 'failed');
    db.prepare("UPDATE runs SET status='completed' WHERE id='002'").run();
    supersedeFollowerAttempts(db, ['001'], '002');
    assert.equal((db.prepare('SELECT status FROM runs WHERE id=?').get('001') as any).status, 'superseded');
    assert.deepEqual(planFollowerRecovery(db, '1', 'alice'), { kind: 'none' });
    assert.equal((db.prepare('SELECT status FROM runs WHERE id=?').get('003') as any).status, 'failed');
  } finally { db.close(); }
});
test('does not auto-recover running tasks, saved batches, or uncertain follow work', () => {
  for (const [status, stage, state] of [ ['running','followers-export',{}], ['failed','filter',{followerBatch:{candidates:[]}}], ['failed','followers-export',{follow:{}}] ] as const) {
    const db = setup(); try { add(db, '001', status, stage, state); assert.deepEqual(planFollowerRecovery(db, '1', 'alice'), { kind:'blocked', id:'001' }); } finally { db.close(); }
  }
});
