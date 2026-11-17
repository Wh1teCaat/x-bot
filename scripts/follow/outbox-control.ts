import { FollowOutbox } from '../../src/follow-outbox.ts';
const [command, account, target] = process.argv.slice(2);
if (!/^\d{1,19}$/.test(account || '') || !['status', 'retry'].includes(command) || (command === 'retry' && !/^\d{1,19}$/.test(target || ''))) throw new Error('用法：node scripts/follow/outbox-control.ts status <账号ID> 或 retry <账号ID> <目标ID>');
const box = new FollowOutbox('.data/following.sqlite');
try {
  if (command === 'status') {
    const rows = box.db.prepare('SELECT target_id, username, source, status, error FROM follow_outbox WHERE account_id=? ORDER BY updated_at,target_id').all(account);
    console.log(JSON.stringify(rows, null, 2));
  } else {
    const follow = box.db.prepare('SELECT status FROM follows WHERE account_id=? AND target_id=?').get(account, target) as { status?: string } | undefined;
    if (follow?.status === 'uncertain') throw new Error('关注结果仍未核实，请先用 loop:health resolve-api-follow 核实');
    if (follow?.status === 'following' || follow?.status === 'pending') {
      box.db.prepare("UPDATE follow_outbox SET status='done',error=NULL,updated_at=? WHERE account_id=? AND target_id=? AND status='manual'").run(Date.now(), account, target);
      console.log('关注已确认，将队列条目标记完成。');
    } else {
      const result = box.db.prepare("UPDATE follow_outbox SET status='queued',error=NULL,updated_at=? WHERE account_id=? AND target_id=? AND status='manual'").run(Date.now(), account, target);
      if (!result.changes) throw new Error('找不到待核实的队列条目');
      console.log('已重新排队；请确保已核实该用户尚未被关注。');
    }
  }
} finally { box.close(); }
