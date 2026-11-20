import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('.data/loop.sqlite');
try {
  const hasJobs = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='loop_jobs'").get();
  if (hasJobs && db.prepare("SELECT 1 FROM loop_jobs WHERE status IN ('running','cooldown') LIMIT 1").get()) throw new Error('存在运行或冷却中的采集任务，请先停止并核实，不能手动解除');
  const hasCircuits = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='circuits'").get();
  if (!hasCircuits) { console.log('没有 X 页面熔断记录。'); }
  else {
    const changed = db.prepare("UPDATE circuits SET state='closed',updated_at=? WHERE scope='x' AND state='open'").run(new Date().toISOString());
    console.log(changed.changes ? 'X 页面熔断已解除。' : '没有可解除的 X 页面熔断。');
  }
} finally { db.close(); }
