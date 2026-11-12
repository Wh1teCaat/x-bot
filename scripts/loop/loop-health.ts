/** 查询本地故障状态并记录人工核实后的关注结果。 */
import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { ResilienceStore } from './resilience.ts';

const [command = 'status', scope, ...extra] = process.argv.slice(2);
const handle = /^@?[A-Za-z0-9_]{1,15}$/;
const validResolution = command === 'resolve-follow' && handle.test(scope || '') && extra.length === 2 && handle.test(extra[0]) && ['following', 'pending', 'not_following'].includes(extra[1]);
const validApiResolution = command === 'resolve-api-follow' && /^\d{1,19}$/.test(scope || '') && extra.length === 2 && /^\d{1,19}$/.test(extra[0]) && ['following', 'pending', 'not_following'].includes(extra[1]);
if (!validResolution && !validApiResolution && (extra.length || (command === 'status' && scope) || (command === 'reset' && !['x', 'llm'].includes(scope)) || !['status', 'reset'].includes(command))) {
  console.error('用法：npm run loop:health 或 -- reset x|llm 或 -- resolve-api-follow <授权账号ID> <目标账号ID> following|pending|not_following'); process.exit(1);
}
let db;
try {
  await mkdir('.data', { recursive: true });
  if (validApiResolution) {
    db = new DatabaseSync('.data/following.sqlite');
    const [target, verified] = extra;
    const result = verified === 'not_following'
      ? db.prepare("DELETE FROM follows WHERE account_id=? AND target_id=? AND status='uncertain'").run(scope, target)
      : db.prepare("UPDATE follows SET status=?,updated_at=? WHERE account_id=? AND target_id=? AND status='uncertain'").run(verified, new Date().toISOString(), scope, target);
    if (!result.changes) throw new Error('没有找到对应的 uncertain API 关注记录');
    console.log('已保存核实结果；未发送关注请求。');
    db.close(); db = null;
  } else if (validResolution) {
    db = new DatabaseSync('.data/browser-follows.sqlite');
    const account = scope.replace(/^@/, '').toLowerCase(), target = extra[0].replace(/^@/, '').toLowerCase(), verified = extra[1];
    const result = verified === 'not_following'
      ? db.prepare("DELETE FROM browser_follows WHERE account=? AND target=? AND status='uncertain'").run(account, target)
      : db.prepare("UPDATE browser_follows SET status=?,updated_at=? WHERE account=? AND target=? AND status='uncertain'").run(verified, new Date().toISOString(), account, target);
    if (!result.changes) throw new Error('没有找到该账号与目标的 uncertain 记录');
    console.log('已根据人工核实结果更新记录；未执行 X 操作或自动重试。');
    db.close(); db = null;
  } else {
  db = new DatabaseSync('.data/loop.sqlite');
  const store = new ResilienceStore(db);
  if (command === 'reset') {
    if (store.circuit(scope)?.state !== 'open') throw new Error(`${scope} 熔断未开启`);
    store.close(scope);
    console.log(`${scope} 熔断已手动解除；未自动重试任务。`);
  } else {
    const circuits = db.prepare('SELECT scope,state,reason,updated_at FROM circuits ORDER BY scope').all();
    const failures = db.prepare("SELECT id,run_id,stage,kind,reason,status,attempts,created_at FROM failure_jobs WHERE status != 'resolved' ORDER BY created_at DESC LIMIT 100").all();
    console.log(JSON.stringify({ circuits, failures }, null, 2));
  }
  }
} catch (error) { console.error(`操作失败：${error.message}`); process.exitCode = 1; }
finally { db?.close(); }
