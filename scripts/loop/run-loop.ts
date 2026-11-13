/** 启动单轮任务队列，并将执行与半开探测交给子进程。 */
import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { connectTestingBrowser } from '../browser/browser-connection.ts';
import { findBloggerPosts, getCollectorPage } from '../replies/reply-export.ts';
import { ResilienceStore } from './resilience.ts';
import { createLoopOrchestrator } from './loop-orchestrator.ts';
import { parseLoopArguments } from './loop-arguments.ts';

let args;
try { args = parseLoopArguments(process.argv.slice(2)); }
catch (error) { console.error(`参数错误：${error.message}`); process.exit(1); }
await mkdir('.data/loop-runs', { recursive: true });
const db = new DatabaseSync('.data/loop.sqlite');
db.exec('CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, status TEXT NOT NULL, stage TEXT NOT NULL, state TEXT NOT NULL, error TEXT, pid INTEGER, updated_at TEXT NOT NULL)');
new ResilienceStore(db);
const runId = args.resumeId || randomUUID();
if (args.resumeId && !db.prepare('SELECT id FROM runs WHERE id=?').get(runId)) { console.error('未找到任务'); db.close(); process.exit(1); }
console.log(`队列任务 ID：${runId}`);
/** 启动单轮子进程；探测模式只允许一次新的关注请求。 */
const execute = ({ resume, probe = false }) => new Promise<number>((resolve, reject) => {
  const childArgs = ['scripts/loop/loop-run.ts', ...(resume ? ['--resume', runId] : ['--run-id', runId]),
    ...(args.accountId ? ['--account-id', args.accountId] : []), ...(args.username ? ['--username', args.username] : []),
    ...(args.blogger ? ['--blogger', args.blogger] : []), ...(args.language ? ['--language', args.language] : []),
    ...(args.evaluate ? ['--evaluate'] : []),
    ...(args.cdpPort ? ['--cdp-port', String(args.cdpPort)] : []), ...(probe ? ['--follow-probe'] : [])];
  const child = spawn(process.execPath, childArgs, { stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', code => resolve(code ?? 1));
});
/** 对博主帖子读取阶段执行只读探测，并拒绝带限流提示的结果。 */
async function probe(row) {
  let browser, context, listener;
  try {
    const blogger = JSON.parse(row.state).blogger;
    if (!blogger) return false;
    browser = await connectTestingBrowser({ timeout: 60000, port: args.cdpPort });
    context = browser.contexts()[0];
    if (!context) return false;
    let limited = false;
    listener = response => {
      try { const h = new URL(response.url()).hostname; if (response.status() === 429 && (h === 'x.com' || h.endsWith('.x.com') || h === 'twitter.com' || h.endsWith('.twitter.com'))) limited = true; } catch {}
    };
    context.on('response', listener);
    const page = await getCollectorPage(context);
    const guard = async () => {
      if (limited || await page.getByText(/sorry, you are rate limited|速率受限|请求过于频繁/i).first().isVisible().catch(() => false)) throw new Error('X 限流');
    };
    const posts = await findBloggerPosts(page, blogger, guard);
    await guard();
    return posts.length > 0;
  } catch { return false; }
  finally { if (context && listener) context.off('response', listener); if (browser?.isConnected()) await browser.close(); }
}
/** 检查当前任务是否存在尚未核实的 API 关注结果。 */
async function hasUncertain(row) {
  if (!row?.state) return true;
  let follows;
  try {
    const state = JSON.parse(row.state);
    if (state.follow && !state.followAccountId) return true;
    const ids = new Set(Object.values(state.followTargetIds || {}));
    if (!ids.size) return false;
    follows = new DatabaseSync('.data/following.sqlite', { readOnly: true });
    return follows.prepare("SELECT target_id FROM follows WHERE account_id=? AND status='uncertain'").all(state.followAccountId).some(r => ids.has(r.target_id));
  } catch { return true; }
  finally { follows?.close(); }
}
const loop = createLoopOrchestrator({ db, runId, execute, probe, hasUncertain, onLog: console.log });
try { const result = await loop.start(); if (result !== 'completed') { console.error(`任务停止：${result}；任务 ID：${runId}`); process.exitCode = 1; } }
finally { loop.close(); db.close(); }
