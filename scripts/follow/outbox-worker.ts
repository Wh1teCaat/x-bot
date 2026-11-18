import '../../src/runtime-config.ts';

import { monitorProcess } from '../../src/runtime-monitor.ts';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { open, readFile, unlink } from 'node:fs/promises';
import { FollowOutbox } from '../../src/follow-outbox.ts';
import { LocalFollowClient } from './api-follow.ts';

const account = process.argv[2];
const confirm = process.argv.includes('--confirm-follow');
if (!/^\d{1,19}$/.test(account || '')) throw new Error('需要账号数字 ID');
const telemetry = monitorProcess(account, 'outbox');
telemetry.stage('准备关注队列');
const lock = `.data/follow-outbox-${account}.lock`;
let owned = false;
for (let attempt = 0; attempt < 2; attempt++) {
  try { const f = await open(lock, 'wx', 0o600); try { await f.writeFile(String(process.pid)); owned = true; } finally { await f.close(); } break; }
  catch (error) {
    if (error.code !== 'EEXIST' || attempt) throw error;
    const pid = (await readFile(lock, 'utf8')).trim();
    if (!/^\d+$/.test(pid)) throw new Error('Outbox 锁无效，请检查');
    try { process.kill(Number(pid), 0); throw new Error('该账号 Outbox 已在运行'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    await unlink(lock);
  }
}
const controller = new AbortController();
process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
const box = new FollowOutbox('.data/following.sqlite');
const client = new LocalFollowClient();
try {
  box.recover(account);
  console.log(`关注 Outbox 已启动：账号 ${account}，每批最多 20 人，批次间隔 15 分钟。`);
  while (!controller.signal.aborted) {
    const batch = box.pending(account);
    const wait = Math.max(0, box.nextBatch(account) - Date.now());
    if (!batch.length || wait) { telemetry.stage(wait && batch.length ? '等待下一批关注' : '等待关注候选', 'waiting'); await sleep(Math.min(wait || 5000, 5000), undefined, { signal: controller.signal }).catch(() => {}); continue; }
    if (confirm) {
      telemetry.stage('等待人工确认关注', 'waiting');
      if (!stdin.isTTY) { console.error('需要逐批确认，但当前终端不可交互；Outbox 暂停。'); break; }
      console.log(`待关注本批 ${batch.length} 人：${batch.map(item => '@' + item.username).join(', ')}`);
      const input = createInterface({ input: stdin, output: stdout });
      let answer = ''; try { answer = (await input.question('输入 y 关注本批，其余输入暂停：', { signal: controller.signal })).trim().toLowerCase(); } catch { break; } finally { input.close(); }
      if (!['y', 'yes'].includes(answer)) { console.log('Outbox 已暂停，待关注用户仍在队列中。'); break; }
    }
    // 在发送前持久化下一批时间，即使中途崩溃或重启也不立即再发一批。
    box.schedule(account, Date.now() + 15 * 60 * 1000);
    for (const item of batch) {
      if (controller.signal.aborted) break;
      if (!box.begin(account, item.target_id)) continue;
      telemetry.stage(`关注 @${item.username}`);
      try {
        const result = await client.follow(account, item.target_id);
        if (result.errors?.length || (!result.data?.following && !result.data?.pending_follow)) throw new Error('X 返回的关注结果不明确');
        box.finish(account, item.target_id, 'done');
        console.log(`Outbox @${item.username}：${result.data.following ? '已关注' : '等待对方批准'}`);
        telemetry.endStep('completed');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 429 和本程序配额明确没有发出成功请求，其他错误必须人工核实。
        const retryable = error.status === 429 || (error.status === 409 && message.includes('关注尝试上限'));
        box.finish(account, item.target_id, retryable ? 'queued' : 'manual', message.slice(0, 300));
        console.error(`Outbox @${item.username} 暂停：${message}`);
        telemetry.endStep('failed');
        break;
      }
    }
  }
} finally { telemetry.finish(controller.signal.aborted ? 'stopped' : 'completed'); box.close(); if (owned) await unlink(lock).catch(() => {}); }
