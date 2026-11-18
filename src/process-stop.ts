/** 按进程树停止任务；发送信号前复核命令，避免使用已被复用的 PID。 */
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
export function processSnapshot() {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,args='], { encoding: 'utf8' }).trim().split('\n').flatMap(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return m ? [{ pid: Number(m[1]), parent: Number(m[2]), command: m[3] }] : [];
  });
}
export async function stopProcessTree(pid: number, includeRoot = true) {
  const snapshot = processSnapshot();
  const ids = new Set([pid]);
  let size = 0;
  while (size !== ids.size) { size = ids.size; for (const row of snapshot) if (ids.has(row.parent)) ids.add(row.pid); }
  const targets = snapshot.filter(row => ids.has(row.pid) && (includeRoot || row.pid !== pid));
  const signal = (kind: NodeJS.Signals) => {
    const current = new Map(processSnapshot().map(row => [row.pid, row.command]));
    for (const row of targets) if (current.get(row.pid) === row.command) {
      try { process.kill(row.pid, kind); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  signal('SIGTERM');
  if (targets.length) { await delay(1500); signal('SIGKILL'); }
}
