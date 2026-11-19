import '../../src/runtime-config.ts';
/** 长时 loop：启动 mirror 子进程监听，执行初始 loop，并持续处理延迟回复任务。 */

import { stopProcessTree } from '../../src/process-stop.ts';
import { monitorProcess } from '../../src/runtime-monitor.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FollowerCheckpoints, FOLLOWER_INTERVAL_MS } from '../browser/follower-batch.ts';
import { AccountStore } from '../../src/account-store.ts';
import { MirrorStore } from '../../src/mirror-store.ts';
import { resolveFlowTarget } from './flow-target.ts';
import { discoverFashionTarget, parseFashionQueries } from '../clone_user/fashion-target.ts';

const raw = process.argv.slice(2);
const accountId = raw[0];
if (!/^\d{1,19}$/.test(accountId || '')) {
  console.error('用法：npm run loop -- <账号数字ID> [--target <博主用户名>] [--cookie <文件>] [--language ar] [--evaluate] [--post <帖子链接>] [--resume <任务ID>] [--loop-only] [--mirror-once|--no-mirror] [--confirm-follow] [--check-only]');
  process.exit(1);
}
const telemetry = monitorProcess(accountId, 'flow');
telemetry.stage('准备账号运行');
let target: string | undefined;
let cookiePath: string | undefined;
let language: 'ar' | undefined;
let postUrl: string | undefined;
let evaluate = false;
let mirror: 'continuous' | 'once' | 'none' = 'continuous';
let checkOnly = false;
let yes = false;
let confirmFollow = false;
let loopOnly = false;
let followersOnly = false;
let resumeId: string | undefined;
for (let index = 1; index < raw.length; index++) {
  const key = raw[index];
  if (key === '--evaluate') { evaluate = true; continue; }
  if (key === '--check-only') { checkOnly = true; continue; }
  if (key === '--yes') { yes = true; continue; }
  if (key === '--confirm-follow') { confirmFollow = true; continue; }
  if (key === '--followers-only') { followersOnly = true; continue; }
  if (key === '--loop-only') { loopOnly = true; continue; }
  if (key === '--mirror-once') { mirror = 'once'; continue; }
  if (key === '--no-mirror') { mirror = 'none'; continue; }
  const value = raw[++index];
  if (!value) { console.error(`${key} 缺少值`); process.exit(1); }
  if (key === '--resume') resumeId = value;
  else if (key === '--target') target = value.replace(/^@/, '');
  else if (key === '--cookie') cookiePath = value;
  else if (key === '--post') {
    if (!/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d{1,19}/i.test(value)) { console.error('--post 必须是 X 帖子链接'); process.exit(1); }
    postUrl = value;
  } else if (key === '--language') {
    if (value !== 'ar') { console.error('目前仅支持 --language ar'); process.exit(1); }
    language = 'ar';
  } else { console.error(`不支持的参数 ${key}`); process.exit(1); }
}
if (target && !/^[A-Za-z0-9_]{1,15}$/.test(target)) { console.error('目标用户名无效'); process.exit(1); }

const dataDir = resolve('.data');
const readAccount = () => {
  const store = new AccountStore(dataDir);
  try { return store.getByUuid(accountId); }
  finally { store.close(); }
};
let account = readAccount();
if (!account) { console.error(`未找到账号 ${accountId}，请先完成 X 授权`); process.exit(1); }
const loginEnv = { ...process.env, ...(cookiePath ? { X_COOKIE_FILE: resolve(cookiePath) } : {}) };
let stopping = false;
let mirrorChild: ChildProcess | null = null;
let outboxChild: ChildProcess | null = null;
let activityChild: ChildProcess | null = null;
let activityRestartTimer: ReturnType<typeof setTimeout> | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let replyChild: ChildProcess | null = null;
let replyTimer: ReturnType<typeof setInterval> | null = null;
let mirrorStore: MirrorStore | null = null;
let resolveStop: (() => void) | null = null;
const stopPromise = new Promise<void>((resolveSignal) => { resolveStop = resolveSignal; });
let stopTask: Promise<void> | null = null;
const stop = (status = 'stopped') => {
  if (stopTask) return stopTask;
  stopping = true;
  telemetry.finish(status);
  if (restartTimer) clearTimeout(restartTimer);
  if (activityRestartTimer) clearTimeout(activityRestartTimer);
  if (replyTimer) clearInterval(replyTimer);
  stopTask = stopProcessTree(process.pid, false).finally(() => resolveStop?.());
  return stopTask;
};
const stopOnSignal = () => { void stop().then(() => process.exit(0), error => { console.error(error); process.exit(1); }); };
process.once('SIGINT', stopOnSignal);
process.once('SIGTERM', stopOnSignal);

if (checkOnly) {
  console.log(`clone 状态：${account.cloned ? `已完成，目标 @${account.copiedFromUsername}` : '未 clone'}`);
  const code = await run(['scripts/loop/login-and-run.ts', accountId, '--check-only'], loginEnv);
  process.exitCode = code;
  process.exit();
}

let chosenTarget = target;
if (!account.cloned && !chosenTarget) {
  const positiveInt = (name: string, fallback: number) => {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  };
  const requiredPosts = Math.min(3, positiveInt('CLONE_TARGET_REQUIRED_POSTS', 2));
  const minReplies = positiveInt('CLONE_TARGET_MIN_REPLIES', 50);
  const minFollowers = positiveInt('CLONE_TARGET_MIN_FOLLOWERS', 1000);
  const maxCandidates = positiveInt('CLONE_TARGET_MAX_CANDIDATES', 40);
  const origin = `http://127.0.0.1:${process.env.PORT || 3000}`;
  console.log('未指定 --target，使用 X API 搜索时尚相关博主。');
  chosenTarget = await discoverFashionTarget({
    accountId,
    origin,
    queries: parseFashionQueries(process.env.FASHION_SEARCH_QUERIES),
    minReplies,
    minFollowers,
    requiredPosts,
    maxCandidates,
  });
}
let resolvedTarget = resolveFlowTarget(account, chosenTarget);
if (loopOnly) {
  console.log(`--loop-only：跳过 clone 和 mirror，目标 @${resolvedTarget}`);
  const code = await run(loopArgs(resolvedTarget), loginEnv);
  process.exit(code);
}
if (account.cloned) {
  console.log(`已 clone 过，跳过 clone；持久化目标 @${resolvedTarget}`);
} else {
  const profileName = resolvedTarget.toLowerCase();
  const cloneArgs = ['scripts/clone_user/clone_user.ts', resolvedTarget, profileName, ...(cookiePath ? ['--cookie', cookiePath] : [])];
  const code = await run(cloneArgs);
  if (code !== 0) { console.error('clone 失败，停止流程'); process.exit(code); }
  account = readAccount();
  if (!account?.cloned) { console.error('clone 结束但账号未标记为已 clone，停止流程'); process.exit(1); }
  resolvedTarget = account.copiedFromUsername || resolvedTarget;
  console.log(`clone 完成并持久化：目标 @${resolvedTarget}`);
}


outboxChild = spawn(process.execPath, ['scripts/follow/outbox-worker.ts', accountId, ...(confirmFollow ? ['--confirm-follow'] : [])], { cwd: process.cwd(), stdio: 'inherit' });
outboxChild.once('error', error => console.error(`关注 Outbox 子进程启动失败：${error.message}`));
outboxChild.once('exit', (code, signal) => { outboxChild = null; if (!stopping) console.error(`关注 Outbox 已停止（code=${code}, signal=${signal}），队列保留。`); });

if (process.env.X_ACTIVITY_APP_BEARER_TOKEN) {
  const startActivity = () => {
    if (stopping) return;
    activityChild = spawn(process.execPath, ['scripts/follow/follow-stream.ts', 'run', accountId, '--app'], { cwd: process.cwd(), stdio: 'inherit' });
    activityChild.once('error', error => console.error(`关注事件子进程启动失败：${error.message}`));
    activityChild.once('exit', (code, signal) => {
      activityChild = null;
      if (!stopping) console.error(`关注事件监听已停止（code=${code}, signal=${signal}）；请检查权限、订阅和日志。`);
    });
    console.log('关注事件监听子进程已启动。');
  };
  startActivity();
} else console.error('未配置 X_ACTIVITY_APP_BEARER_TOKEN，关注事件监听未启动。');

const mirrorArgs = ['scripts/mirror/mirror-loop.ts', resolvedTarget, accountId, '--no-reply-scheduler',
  ...(mirror === 'once' ? ['--backfill-only'] : [])];
const startMirror = () => {
  if (stopping || mirror === 'none') return;
  mirrorChild = spawn(process.execPath, mirrorArgs, { cwd: process.cwd(), stdio: 'inherit' });
  mirrorChild.once('error', (error) => console.error(`mirror 子进程启动失败：${error.message}`));
  mirrorChild.once('exit', (code, signal) => {
    mirrorChild = null;
    if (stopping || mirror !== 'continuous') return;
    console.error(`mirror 子进程退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}），5 秒后重启。`);
    restartTimer = setTimeout(() => { restartTimer = null; startMirror(); }, 5000);
  });
  console.log('mirror 子进程已启动，实时监听目标新帖。');
};
if (mirror !== 'none') startMirror();

const loopCode = await run(loopArgs(resolvedTarget), loginEnv);
resumeId = undefined;
if (stopping) { await stop(); process.exit(0); }
if (loopCode !== 0) {
  console.error('初始 loop 失败，停止该账号全部任务；队列和断点保留。');
  await stop('failed');
  process.exit(loopCode);
}
// --no-mirror 仍保留粉丝定时调度和关注 Outbox。
if (mirror === 'once') {
  if (mirrorChild) await new Promise<void>((resolveExit) => mirrorChild!.once('exit', () => resolveExit()));
  await stop(loopCode ? 'failed' : 'completed');
  process.exit(loopCode);
}

mirrorStore = new MirrorStore(resolve(dataDir, 'mirror.sqlite'));
mirrorStore.recoverStaleReplyJobs(new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString());
const schedulerMs = Math.max(1000, Number(process.env.MIRROR_REPLY_SCHEDULER_MS) || 60_000);
const retryMs = Math.max(1000, Number(process.env.MIRROR_REPLY_RETRY_MS) || 10 * 60 * 1000);
const autoYes = /^(1|true|yes)$/i.test(process.env.MIRROR_REPLY_AUTO_YES || '');
telemetry.stage('等待定时任务', 'waiting');
console.log(`loop 进入长时运行；每 ${Math.round(schedulerMs / 1000)} 秒检查延迟回复任务。`);

/** 处理到期的单帖回复任务；串行，避免与当前 loop 争用账号。 */
let followerScheduleBlocked = loopCode !== 0;
const processDueFollowerBatch = async (): Promise<boolean> => {
  if (followerScheduleBlocked || postUrl) return false;
  const db = new DatabaseSync(resolve(dataDir, 'loop.sqlite'));
  db.exec('PRAGMA busy_timeout=10000');
  let checkpoint;
  try {
    checkpoint = new FollowerCheckpoints(db).get(accountId, resolvedTarget);
    // 上次失败/中断的粉丝任务须先恢复，不能另起任务跳过尚未入队的批次。
    const pending = db.prepare("SELECT state FROM runs WHERE status != 'completed'").all().some(row => {
      const state = JSON.parse(String(row.state));
      return state.followAccountId === accountId && state.blogger?.toLowerCase() === resolvedTarget.toLowerCase() && state.phase === 'followers';
    });
    if (pending) { followerScheduleBlocked = true; console.error('存在未完成粉丝任务，请先用 --resume 恢复；定时抓取暂停。'); return false; }
  } finally { db.close(); }
  if (checkpoint.done || checkpoint.due > Date.now()) return false;
  telemetry.stage('执行粉丝定时续抓');
  console.log(`开始粉丝定时续抓（每 ${Math.round(FOLLOWER_INTERVAL_MS / 60_000)} 分钟一批）：本批最多 200 人。`);
  replyChild = spawn(process.execPath, [...loopArgs(resolvedTarget).filter(arg => arg !== '--followers-only'), '--followers-only'], { cwd: process.cwd(), stdio: 'inherit', env: loginEnv });
  const code = await new Promise<number>(resolveCode => {
    replyChild!.once('error', () => resolveCode(1));
    replyChild!.once('exit', code => resolveCode(code ?? 1));
  });
  replyChild = null;
  if (code !== 0) { followerScheduleBlocked = true; console.error('粉丝续抓失败，断点保留；请检查并恢复后重启定时调度。'); }
  telemetry.stage('等待定时任务', 'waiting');
  return true;
};
const processDueReplyJob = async () => {
  if (stopping || replyChild || !mirrorStore) return;
  if (await processDueFollowerBatch()) return;
  if (stopping) return;
  const [job] = mirrorStore.dueReplyJobs(Date.now(), 1);
  if (!job || !mirrorStore.claimReplyJob(job)) return;
  telemetry.stage('执行延迟回复任务');
  console.log(`开始延迟回复爬取：${job.postUrl}（第 ${job.attempts + 1}/3 次）`);
  const args = ['scripts/loop/flow.ts', job.posterId, '--loop-only', '--post', job.postUrl, '--target', job.targetUsername,
    ...(yes || autoYes ? ['--yes'] : []), ...(cookiePath ? ['--cookie', cookiePath] : [])];
  replyChild = spawn(process.execPath, args, { cwd: process.cwd(), stdio: 'inherit' });
  const code = await new Promise<number>((resolveCode) => {
    replyChild!.once('error', () => resolveCode(1));
    replyChild!.once('exit', (exitCode) => resolveCode(exitCode ?? 1));
  });
  replyChild = null;
  telemetry.stage('等待定时任务', 'waiting');
  try {
    if (code === 0) {
      mirrorStore.finishReplyJob(job, 'done', null);
      console.log(`延迟回复爬取完成：${job.tweetId}`);
    } else {
      mirrorStore.finishReplyJob(job, 'failed', `exit ${code}`, Date.now() + retryMs);
      console.log(`延迟回复爬取失败：${job.tweetId}，${Math.round(retryMs / 60_000)} 分钟后重试。`);
    }
  } catch (error) {
    if (!stopping) console.error(`记录回复任务结果失败：${error instanceof Error ? error.message : String(error)}`);
  }
};
replyTimer = setInterval(() => {
  void processDueReplyJob().catch((error) => console.error(`延迟回复任务调度失败：${error instanceof Error ? error.message : String(error)}`));
}, schedulerMs);

await stopPromise;
await stop();
if (replyChild) replyChild.kill('SIGINT');
if (mirrorStore) mirrorStore.close();
console.log('loop 已停止。');
process.exit(0);

function loopArgs(blogger: string): string[] {
  return ['scripts/loop/login-and-run.ts', accountId, '--blogger', blogger,
    ...(followersOnly ? ['--followers-only'] : []), ...(language ? ['--language', language] : []), ...(evaluate ? ['--evaluate'] : []),
    ...(yes ? ['--yes'] : []), ...(postUrl ? ['--post', postUrl] : []), ...(resumeId ? ['--resume', resumeId] : [])];
}

async function run(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  telemetry.stage(args[0].includes('clone_user') ? '复制目标账号资料' : '登录并执行采集流程');
  const code = await new Promise<number>((resolveCode) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', cwd: process.cwd(), env: { ...env, X_RUNTIME_ACCOUNT_ID: accountId } });
    child.once('error', error => { console.error(`子进程启动失败：${error.message}`); resolveCode(1); });
    child.once('exit', (code) => resolveCode(code ?? 1));
  });
  if (stopping) { await stop(); process.exit(0); }
  return code;
}
