import '../../src/runtime-config.ts';
/** 执行博主帖子采集、导出、固定规则筛选、可选评估和关注的单轮阶段。 */

import { monitorProcess } from '../../src/runtime-monitor.ts';
import { stageLabels } from '../../src/console-data.ts';
import { connectTestingBrowser } from '../browser/browser-connection.ts';
import { actionDelay, createProfileVisitDelay } from '../browser/action-delay.ts';
import { openExporter24, readExporter24Counts, EXPORTER24_EXTENSION_ID } from '../browser/exporter24.ts';
import { withExporterLock, withExporterRetryLock } from '../browser/exporter-lock.ts';
import { FollowerCheckpoints, readFollowerBatch, stopFollowerBatchForRetry, FOLLOWER_INTERVAL_MS, FollowerHistoryError } from '../browser/follower-batch.ts';
import { ExporterRetry, ExporterError } from '../browser/exporter-retry.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { findBloggerPosts, getCollectorPage, scanAndExport } from '../replies/reply-export.ts';
import { enrichCsv, partitionFollowerCandidates, partitionReplyCandidates } from '../replies/reply-candidates.ts';
import { readProfileCounts } from '../replies/profile-counts.ts';
import { sortPostsNewestFirst } from '../replies/post-order.ts';
import { qualifyByFollowerBalance, selectFollowCandidates, MAX_FOLLOW_RATIO } from '../replies/follower-filter.ts';
import { makeLlm, evaluateCandidates } from './loop-llm.ts';
import { LocalFollowClient } from '../follow/api-follow.ts';
import { FollowOutbox } from '../../src/follow-outbox.ts';
import { ResilienceStore, classifyFailure, retryTransient } from './resilience.ts';
import { parseLoopArguments } from './loop-arguments.ts';
import { AccountStore } from '../../src/account-store.ts';
import { ProcessedPosts } from './processed-posts.ts';

let args;
try { args = parseLoopArguments(process.argv.slice(2), true); }
catch (error) { console.error(`参数错误：${error.message}`); process.exit(1); }
const resumeId = args.resumeId;
const handle = /^[A-Za-z0-9_]{1,15}$/;
const targetFor = blogger => `判断候选用户是否与博主 @${blogger} 的公开话题相关，仅依据回复文本`;
let browser, db, state, runId, stage = 'search', runPersisted = false, options;
const accountStore = new AccountStore(resolve('.data'));
/** clone 完成后，来源博主保存在该授权账号的账号记录中。 */
const clonedBlogger = () => {
  if (!args.accountId) return null;
  return accountStore.getByUuid(args.accountId)?.copiedFromUsername ?? null;
};
let blogger = clonedBlogger() || args.blogger;
await mkdir('.data/loop-runs', { recursive: true });
db = new DatabaseSync('.data/loop.sqlite');
// 控制台、flow 定时器和本进程会并发读写同一份状态库；必须等待而不是立即报 database is locked。
db.exec('PRAGMA busy_timeout=10000');
db.exec(`CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, status TEXT NOT NULL, stage TEXT NOT NULL, state TEXT NOT NULL, error TEXT, pid INTEGER, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS posts(id TEXT PRIMARY KEY, run_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS evaluated_users(username TEXT PRIMARY KEY, run_id TEXT NOT NULL);`);
const resilience = new ResilienceStore(db);
const followerCheckpoints = new FollowerCheckpoints(db);
const processedPosts = new ProcessedPosts(db);
let telemetry = monitorProcess(args.accountId, 'loop');
telemetry.stage('准备采集任务');
const followProbe = args.followProbe;
const ensureX = () => {
  const circuit = resilience.circuit('x');
  if (circuit?.state === 'half_open') throw new Error('X 熔断处于半开探测中');
  resilience.ensureClosed('x');
};
/** 每个阶段完成后保存任务状态，供失败或进程重启后恢复。 */
const persist = (status, error = null) => {
  const result = db.prepare('UPDATE runs SET status=?, stage=?, state=?, error=?, pid=?, updated_at=? WHERE id=?')
    .run(status, stage, JSON.stringify(state), error, status === 'running' ? process.pid : null, new Date().toISOString(), runId);
  if (status === 'running') {
    const context = state.phase === 'followers' ? '粉丝' : `帖子 ${(state.postIndex || 0) + 1}/${state.posts?.length || '?'}`;
    telemetry.stage(`${stageLabels[stage] || stage} · ${context}`);
  } else if (status === 'completed') telemetry.endStep('completed');
  else if (['failed', 'incomplete'].includes(status)) telemetry.endStep('failed');
  return result;
};
/** 避免同一任务在已有进程仍存活时被重复启动。 */
const assertNotRunning = row => {
  if (row.status !== 'running' || !row.pid) return;
  try { process.kill(row.pid, 0); } catch (e) { if (e.code === 'ESRCH') return; throw e; }
  throw new Error('任务仍在运行，不能重复启动');
};
/** 记录已经过固定规则（以及可选评估）的用户，后续任务不再重复处理。 */
const markProcessed = items => {
  if (!items.length) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const insert = db.prepare('INSERT OR IGNORE INTO evaluated_users VALUES (?, ?)');
    for (const item of items) insert.run(item.username.toLowerCase(), runId);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
};
try {
  if (resumeId) {
    const row = db.prepare('SELECT * FROM runs WHERE id=?').get(resumeId);
    if (!row) throw new Error('未找到任务');
    assertNotRunning(row);
    if (row.status === 'completed') throw new Error('该轮已完成');
    if (row.status === 'superseded') throw new Error('该粉丝任务已由其他任务恢复，不能重复执行');
    if (row.stage === 'export' || (row.stage === 'followers-export' && !JSON.parse(row.state).followerBatchMode)) throw new Error('导出阶段曾中断，无法确认插件是否停止；请先检查 Chrome 中的插件状态');
    runId = row.id; stage = row.stage; state = JSON.parse(row.state); runPersisted = true;
    if (!args.accountId && state.followAccountId) telemetry = monitorProcess(state.followAccountId, 'loop');
    if (state.version !== 5) throw new Error('旧版任务不能自动迁移，请新建一轮');
    if (args.accountId && state.followAccountId && args.accountId !== state.followAccountId) throw new Error('恢复任务的授权账号与原任务不一致');
    if (args.username && state.browserUsername && args.username.toLowerCase() !== state.browserUsername.toLowerCase()) throw new Error('恢复任务的浏览器账号与原任务不一致');
    if (args.blogger && state.blogger && args.blogger.toLowerCase() !== state.blogger.toLowerCase()) throw new Error('恢复任务的博主与原任务不一致');
    blogger = state.blogger || blogger;
    if (!handle.test(blogger)) throw new Error('恢复任务缺少博主；请用 --blogger <用户名> 指定');
    state.blogger = blogger;
    state.target = state.target || targetFor(blogger);
    const stored = state.options || { language: args.language ?? null, evaluate: args.evaluate };
    if (args.language && stored.language && args.language !== stored.language) throw new Error('恢复任务的语言筛选与原任务不一致');
    if (args.evaluate && !stored.evaluate) throw new Error('恢复任务未启用模型评估，不能中途启用');
    options = state.options = { language: stored.language ?? null, evaluate: Boolean(stored.evaluate) };
    if (args.accountId && !state.followAccountId) {
      if (state.follow) throw new Error('旧浏览器关注任务需要先核对，不能直接绑定 API 账号');
      state.followAccountId = args.accountId;
    }
    if (args.username && !state.browserUsername) state.browserUsername = args.username;
    persist('running');
  } else {
    if (!handle.test(blogger)) throw new Error('未找到 clone 来源博主；请先 clone，或用 --blogger <用户名> 指定');
    if (args.accountId && !args.postUrl && !args.noFollowers && !args.ignorePendingFollowers) {
      const pending = db.prepare("SELECT id,state FROM runs WHERE status NOT IN ('completed','superseded')").all().find(row => {
        const saved = JSON.parse(String(row.state));
        return saved.followAccountId === args.accountId && saved.blogger?.toLowerCase() === blogger.toLowerCase() && saved.phase === 'followers';
      });
      if (pending) throw new Error(`存在未完成粉丝任务 ${pending.id}，请先用 --resume 恢复`);
    }
    if (args.followersOnly) stage = 'followers-export';
    options = { language: args.language ?? null, evaluate: args.evaluate };
    runId = args.runId || randomUUID();
    state = {
      target: targetFor(blogger), version: 5, blogger, options, evaluations: [],
      posts: [], postIndex: 0, phase: args.followersOnly ? 'followers' : 'replies', results: [], followerBatchMode: true,
      singlePost: Boolean(args.postUrl), ...(args.postUrl ? { singlePostUrl: args.postUrl } : {}),
      ...(args.accountId ? { followAccountId: args.accountId } : {}),
      ...(args.username ? { browserUsername: args.username } : {}),
    };
    // 帖子和粉丝是两条独立 lane：各自最多一个任务，彼此可以并发。
    const lane = args.followersOnly ? 'followers' : 'posts';
    db.exec('BEGIN IMMEDIATE');
    try {
      // 非 lane 模式（手工启动）仍保持原来的全局串行限制。
      if (!args.followersOnly && !args.noFollowers && !args.postUrl && !args.ignorePendingFollowers) {
        for (const job of db.prepare("SELECT owner_pid FROM loop_jobs WHERE id<>? AND status IN ('running','cooldown') AND owner_pid IS NOT NULL").all(runId)) {
          try { process.kill(Number(job.owner_pid), 0); throw new Error('已有其他账号的任务运行或冷却，当前版本不支持并行'); }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
      }
      for (const row of db.prepare("SELECT * FROM runs WHERE status='running'").all()) {
        let saved: { phase?: string } = {};
        try { saved = JSON.parse(String(row.state)); } catch { /* 旧数据按 posts lane 处理 */ }
        if ((saved.phase === 'followers' ? 'followers' : 'posts') === lane) assertNotRunning(row);
      }
      db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, NULL, ?, ?)').run(runId, 'running', stage, JSON.stringify(state), process.pid, new Date().toISOString());
      db.exec('COMMIT');
      runPersisted = true;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  persist('running');
  console.log(`任务 ID：${runId}；博主：@${state.blogger}；当前阶段：${stage}`);
  // 只有真正进入可选模型评估阶段才要求模型配置。
  let llm;
  const getLlm = () => llm || (llm = makeLlm());
  let page;
  let xTransientFailures = 0;
  /** 连接测试浏览器并监听 X 页面请求中的 429 响应。 */
  async function getPage() {
    ensureX();
    if (page && !page.isClosed()) return page;
    console.log('连接 Chrome；如有调试连接请求，请在浏览器中允许。');
    browser = await connectTestingBrowser({ timeout: 60000, port: args.cdpPort });
    const context = browser.contexts()[0];
    if (!context) throw new Error('没有可用的 Chrome 上下文');
    context.on('response', response => {
      try {
        const host = new URL(response.url()).hostname.toLowerCase();
        if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) {
          if (response.status() === 429) resilience.open('x', 'X 返回 HTTP 429');
          else if (response.status() >= 500) {
            if (++xTransientFailures >= 3) resilience.open('x', 'X 页面请求连续出现服务端错误');
          } else if (response.status() < 400) xTransientFailures = 0;
        }
      } catch {}
    });
    page = await getCollectorPage(context); await page.bringToFront();
    if (state.browserUsername) {
      const href = await page.getByTestId('AppTabBar_Profile_Link').getAttribute('href', { timeout: 15000 });
      if (href?.toLowerCase() !== `/${state.browserUsername.toLowerCase()}`) throw new Error('浏览器登录账号与授权账号不一致');
    }
    return page;
  }
  /** 在页面操作前检查持久化熔断以及可见限流提示。 */
  const guardX = async () => {
    ensureX();
    if (!page || page.isClosed()) return;
    const limited = await page.getByText(/sorry, you are rate limited|速率受限|请求过于频繁/i).first().isVisible().catch(() => false);
    if (limited) { resilience.open('x', '页面显示速率限制'); throw new Error('X 页面显示速率受限'); }
  };
  while (stage !== 'done') {
  // 采集博主最近 10 条有回复的帖子，按新到旧处理。
  if (stage === 'search') {
    processedPosts.importHistory(state.followAccountId);
    if (state.singlePost) {
      const postUrl = state.singlePostUrl || args.postUrl;
      if (!postUrl) throw new Error('单帖任务缺少帖子链接');
      if (processedPosts.has(state.followAccountId, postUrl)) {
        stage = 'done'; persist('completed');
        console.log(`帖子已处理，跳过：${postUrl}`);
        continue;
      }
      state.posts = [{ url: postUrl, replies: null }];
      state.postIndex = 0;
      state.phase = 'replies';
      state.post = state.posts[0];
      state.results = [];
      resilience.resolve(runId, 'search');
      stage = 'export'; persist('running');
      console.log(`单帖回复爬取：${postUrl}（不处理粉丝列表）`);
    } else {
      const posts = await findBloggerPosts(await getPage(), state.blogger, guardX);
      resilience.ensureClosed('x');
      const withReplies = sortPostsNewestFirst(
        posts.filter(post => typeof post.replies === 'number' && post.replies > 0),
      ).slice(0, 10);
      if (!withReplies.length) throw new Error(`博主 @${state.blogger} 最近的帖子都没有回复`);
      state.posts = withReplies.filter(post => !processedPosts.has(state.followAccountId, post.url));
      const skipped = withReplies.length - state.posts.length;
      if (skipped) console.log(`最近帖子中 ${skipped} 条已处理，跳过；剩余 ${state.posts.length} 条。`);
      if (!state.posts.length) {
        resilience.resolve(runId, 'search');
        if (args.noFollowers) {
          stage = 'done'; persist('completed');
          console.log('最近帖子均已处理，粉丝任务由定时调度串行处理。');
        } else {
          state.phase = 'followers'; state.post = null;
          stage = 'followers-export'; persist('running');
          console.log('最近帖子均已处理，转入博主粉丝导出。');
        }
        continue;
      }
      state.postIndex = 0;
      state.phase = 'replies';
      state.post = state.posts[0];
      state.results = [];
      resilience.resolve(runId, 'search');
      stage = 'export'; persist('running');
      console.log(`博主 @${state.blogger}：选择 ${state.posts.length} 条有回复的最近帖子，按新到旧处理。`);
    }
  }
  if (stage === 'export') {
    state.export = await scanAndExport(await getPage(), state.post, '.data/reply-exports', guardX);
    if (state.export.text) {
      state.post.text = state.export.text;
      state.target = `判断候选用户的回复是否与博主 @${state.blogger} 的这条帖子主题相关；帖子内容：${state.export.text.slice(0, 500)}`;
    }
    resilience.ensureClosed('x');
    resilience.resolve(runId, 'export');
    stage = 'filter'; persist('running');
    const source = state.export.expectedCount
      ? `（帖子显示 ${state.export.expectedCount} 条回复${state.export.plan === 'free' ? '，CommentCrate 免费版仅一级评论' : ''}）`
      : '';
    console.log(`帖 ${state.postIndex + 1}/${state.posts.length} 回复导出 ${state.export.count} 条${source}；停止原因 ${state.export.stoppedWhy || '未知'}`);
  }
  // 帖子全部处理完后，用 exporter24 导出博主粉丝 CSV。
  if (stage === 'followers-export') {
    if (!state.followAccountId) throw new Error('粉丝断点需要绑定授权账号');
    const checkpoint = followerCheckpoints.get(state.followAccountId, state.blogger);
    if (checkpoint.done || checkpoint.due > Date.now()) {
      stage = 'done'; persist('completed');
      console.log(checkpoint.done ? '博主粉丝已抓取完毕。' : `粉丝下一批尚未到期，等待 ${Math.round(FOLLOWER_INTERVAL_MS / 60_000)} 分钟定时调度。`);
      continue;
    }
    const page = await getPage();
    let exporterPage = null;
    if (args.keepBrowser) {
      // 常驻粉丝页：复用同一 Chrome 里已经打开的 exporter 页面，避免按 taskId 重新加载。
      exporterPage = page.context().pages().find(item => !item.isClosed() && item.url().startsWith(`chrome-extension://${EXPORTER24_EXTENSION_ID}/`)) ?? null;
    }
    if (!exporterPage) {
      const openRetry = new ExporterRetry(db, `exporter-open:${state.followAccountId}`);
      exporterPage = await withExporterRetryLock(state.followAccountId, () => openRetry.run(() => withExporterLock(() => openExporter24(page.context(), { throwOnLoadedError: true })), { guard: guardX }));
    }
    if (!exporterPage) throw new Error('未检测到 exporter24 扩展');
    let batchSaved = false;
    try {
      const retry = new ExporterRetry(db, `exporter:${state.followAccountId}`);
      const result = await withExporterRetryLock(state.followAccountId, () => retry.run(() => withExporterLock(async () => {
        try {
          return await readFollowerBatch(exporterPage, state.blogger, checkpoint, taskId => {
            checkpoint.taskId = taskId;
            followerCheckpoints.save(state.followAccountId, state.blogger, checkpoint);
          }, guardX, { recoverTimeout: (retry.get()?.attempts || 0) > 0 });
        } catch (error) {
          if (error instanceof FollowerHistoryError) throw error;
          if (!await stopFollowerBatchForRetry(exporterPage)) throw new ExporterError('无法确认 exporter24 任务已停止，请人工检查后恢复', false, error);
          throw error;
        }
      }), { guard: guardX }));
      state.followerBatch = result;
      state.phase = 'followers';
      state.post = null;
      state.export = { count: result.candidates.length, stoppedWhy: 'followers-batch' };
      resilience.resolve(runId, 'followers-export');
      stage = 'filter'; persist('running');
      batchSaved = true;
      console.log(`粉丝本批 ${result.candidates.length} 人，开始筛选并入队。`);
    } finally {
      if (batchSaved && !args.keepBrowser) await exporterPage.close().catch(() => {});
    }
  }
  // 按阶段解析回复 CSV 或博主粉丝 CSV；语言筛选/模型评估只用于帖子回复。
  if (stage === 'filter') {
    const already = db.prepare('SELECT run_id FROM evaluated_users WHERE username=?');
    const keep = candidate => candidate.username.toLowerCase() !== state.blogger.toLowerCase() && !already.get(candidate.username.toLowerCase());
    state.evaluations = [];
    state.qualify = null;
    state.follow = undefined;
    state.followTargetIds = undefined;
    let hasCounts = false;
    if (state.phase === 'followers') {
      const all = state.followerBatch
        ? { candidates: state.followerBatch.candidates, hasFollowerCounts: true }
        : partitionFollowerCandidates(await readFile(state.export.destination, 'utf8'));
      hasCounts = all.hasFollowerCounts;
      state.direct = [];
      state.candidates = all.candidates.filter(keep);
      console.log(`粉丝本批：${all.candidates.length} 人；进入固定规则筛选 ${state.candidates.length} 人。`);
    } else {
      const postId = new URL(state.post.url).pathname.split('/').pop();
      const all = partitionReplyCandidates(await readFile(state.export.destination, 'utf8'), postId);
      hasCounts = all.hasFollowerCounts;
      const direct = all.direct.filter(keep);
      const remaining = all.remaining.filter(keep);
      if (options.language === 'ar') {
        state.direct = direct;
        state.candidates = options.evaluate ? remaining : [];
        console.log(`语言筛选：阿拉伯文字 ${direct.length} 人；其余 ${options.evaluate ? `${remaining.length} 人交由模型评估` : '不参与本轮'}。`);
      } else {
        state.direct = [];
        state.candidates = [...direct, ...remaining];
        console.log(`未启用语言筛选：${state.candidates.length} 人进入固定规则筛选。`);
      }
    }
    const missingCounts = [...state.direct, ...state.candidates].filter(c => c.followers === undefined || c.following === undefined).length;
    console.log(`CSV 关注/粉丝数：${hasCounts ? '已包含' : '未包含'}；${missingCounts} 人需要通过 exporter24 或主页读取。`);
    resilience.resolve(runId, 'filter');
    stage = 'qualify'; persist('running');
  }
  // 固定规则优先使用 CSV 数据；缺失时先用 exporter24，再回退到逐个主页读取。
  if (stage === 'qualify') {
    state.profileCounts ??= {};
    const allCandidates = [...state.direct, ...state.candidates];
    const hasBoth = candidate => candidate.followers !== undefined && candidate.following !== undefined;
    const applySaved = () => {
      for (const candidate of allCandidates) {
        const saved = state.profileCounts[candidate.username.toLowerCase()];
        if (!saved) continue;
        if (candidate.followers === undefined && saved.followers !== undefined) candidate.followers = saved.followers;
        if (candidate.following === undefined && saved.following !== undefined) candidate.following = saved.following;
      }
    };
    applySaved();
    let needCounts = allCandidates.filter(candidate => !hasBoth(candidate));
    if (needCounts.length) {
      const page = await getPage();
      let exporterPage = null;
      try {
        // 粉丝抓取和补数共用 exporter，同一时间只允许一个任务。
        const openRetry = new ExporterRetry(db, `exporter-open:${state.followAccountId || 'shared'}`);
        exporterPage = await withExporterRetryLock(state.followAccountId, () => openRetry.run(() => withExporterLock(() => openExporter24(page.context(), { throwOnLoadedError: true })), { guard: guardX }));
      } catch (error) {
        if (error instanceof ExporterError || resilience.circuit('x')?.state === 'open') throw error;
        console.log(`exporter24 补数未执行：${error?.message || error}，改用主页读取。`);
        exporterPage = null;
      }
      if (exporterPage) {
        console.log(`检测到 exporter24，用扩展读取 ${needCounts.length} 人的关注/粉丝数。`);
        const retry = new ExporterRetry(db, `exporter:${state.followAccountId || 'shared'}`);
        let consecutiveFailures = 0;
        try {
          for (let index = 0; index < needCounts.length; index++) {
            const candidate = needCounts[index];
            if (hasBoth(candidate)) continue;
            const key = candidate.username.toLowerCase();
            await guardX();
            try {
              const counts = await withExporterRetryLock(state.followAccountId, () => retry.run(() => withExporterLock(async () => {
                await guardX();
                await actionDelay(exporterPage);
                return readExporter24Counts(exporterPage, candidate.username, guardX);
              }), { guard: guardX }));
              consecutiveFailures = 0;
              state.profileCounts[key] = counts;
              if (counts.followers !== undefined) candidate.followers = counts.followers;
              if (counts.following !== undefined) candidate.following = counts.following;
              if ((index + 1) % 10 === 0 || !hasBoth(candidate)) {
                console.log(`exporter24 ${index + 1}/${needCounts.length}：@${candidate.username} 粉丝 ${counts.followers ?? '未知'}，关注 ${counts.following ?? '未知'}。`);
              }
            } catch (error) {
              if (resilience.circuit('x')?.state === 'open') throw error;
              if (error instanceof ExporterError) throw error;
              consecutiveFailures++;
              state.profileCounts[key] = { error: String(error?.message || error).slice(0, 300) };
              console.log(`exporter24 失败 @${candidate.username}：${error?.message || error}`);
              if (consecutiveFailures >= 5) {
                console.log('exporter24 连续失败，改用主页读取剩余用户。');
                break;
              }
            }
            if ((index + 1) % 10 === 0) persist('running');
          }
        } finally {
          await exporterPage.close().catch(() => {});
        }
        persist('running');
      } else {
        console.log('无法打开 exporter24 扩展页，改用主页读取；请检查前面的错误和该账号 Chrome 的扩展状态。');
      }

      needCounts = allCandidates.filter(candidate => !hasBoth(candidate));
      if (needCounts.length) {
        console.log(`主页读取剩余 ${needCounts.length} 人的关注/粉丝数；不调用 X API。`);
        await page.bringToFront();
        const visitDelay = createProfileVisitDelay(page);
        let consecutiveFailures = 0;
        for (let index = 0; index < needCounts.length; index++) {
          const candidate = needCounts[index];
          if (hasBoth(candidate)) continue;
          const key = candidate.username.toLowerCase();
          await guardX();
          await actionDelay(page);
          try {
            const counts = await readProfileCounts(page, candidate.username, guardX);
            consecutiveFailures = 0;
            state.profileCounts[key] = counts;
            if (counts.followers !== undefined) candidate.followers = counts.followers;
            if (counts.following !== undefined) candidate.following = counts.following;
            if ((index + 1) % 10 === 0 || !hasBoth(candidate)) {
              console.log(`主页读数 ${index + 1}/${needCounts.length}：@${candidate.username} 粉丝 ${counts.followers ?? '未知'}，关注 ${counts.following ?? '未知'}。`);
            }
          } catch (error) {
            // 熔断或明确的限流必须停止整批读取；连续失败也停止，避免静默排除全部候选。
            if (resilience.circuit('x')?.state === 'open') throw error;
            consecutiveFailures++;
            if (consecutiveFailures >= 5) throw new Error(`连续 ${consecutiveFailures} 个主页读取失败，已停止：${error?.message || error}`);
            state.profileCounts[key] = { error: String(error?.message || error).slice(0, 300) };
            console.log(`主页读数失败 @${candidate.username}：${error?.message || error}`);
          }
          if ((index + 1) % 10 === 0) persist('running');
          await visitDelay();
        }
        persist('running');
      }
    }
    if (state.export.destination) try {
      const counts = Object.fromEntries(allCandidates.map(candidate => [
        candidate.username.toLowerCase(),
        { followers: candidate.followers, following: candidate.following },
      ]));
      const enriched = enrichCsv(await readFile(state.export.destination, 'utf8'), counts);
      const path = state.export.destination.replace(/\.csv$/i, '-enriched.csv');
      await writeFile(path, enriched, { mode: 0o600 });
      state.export.enrichedDestination = path;
      console.log(`已把关注/粉丝数写回 CSV：${path}`);
      persist('running');
    } catch (error) {
      console.error(`无法写回补充列 CSV：${error?.message || error}`);
    }
    const directResult = qualifyByFollowerBalance(state.direct);
    const remainingResult = qualifyByFollowerBalance(state.candidates);
    const qualifiedDirect = directResult.qualified;
    const qualifiedCandidates = remainingResult.qualified;
    const rejected = [...directResult.rejected, ...remainingResult.rejected];
    state.qualify = { qualifiedDirect, qualifiedCandidates, rejected };
    resilience.resolve(runId, 'qualify');
    const hasModelPool = state.phase === 'replies' && options.evaluate && qualifiedCandidates.length > 0;
    stage = hasModelPool ? 'evaluate' : 'follow';
    persist('running');
    console.log(`固定规则（关注和粉丝均大于 50、相差不超过 ${MAX_FOLLOW_RATIO} 倍）[${state.phase === 'followers' ? '粉丝' : '回复'}] 入选 ${qualifiedDirect.length + qualifiedCandidates.length} 人，排除 ${rejected.length} 人。`);
  }
  if (stage === 'evaluate') {
    const pool = state.qualify.qualifiedCandidates;
    for (let index = state.evaluations.length; index < pool.length; index += 10) {
      resilience.ensureClosed('llm');
      const result = await retryTransient(() => evaluateCandidates(getLlm(), pool.slice(index, index + 10), state.target));
      state.evaluations.push(...result);
      persist('running');
      console.log(`模型已评估 ${state.evaluations.length}/${pool.length} 人。`);
    }
    const output = join('.data/loop-runs', `${runId}.json`);
    await writeFile(`${output}.tmp`, JSON.stringify({ runId, target: state.target, blogger: state.blogger, options, post: state.post, export: state.export, qualify: state.qualify, direct: state.qualify.qualifiedDirect, candidates: state.evaluations }, null, 2), { mode: 0o600 });
    await rename(`${output}.tmp`, output);
    resilience.resolve(runId, 'evaluate');
    state.resultPath = output; stage = 'follow'; persist('running');
  }
  // 只读的用户 ID 解析与 Outbox 入队分别保存断点。
  if (stage === 'follow' || stage === 'follow-lookup') {
    const selected = selectFollowCandidates({
      qualifiedDirect: state.qualify?.qualifiedDirect || [],
      qualifiedCandidates: state.qualify?.qualifiedCandidates || [],
      evaluations: state.evaluations,
      evaluate: state.phase === 'replies' && options.evaluate,
    });
    if (state.follow && !state.followAccountId) throw new Error('旧浏览器关注任务需要核对已处理和未确认用户，不能直接切换到 API 续跑');
    if (followProbe) throw new Error('旧版关注探测不能自动迁移至 Outbox，请先核实旧任务');
    if (state.follow?.matched?.some(item => item.status !== 'queued') || state.followConfirmation) throw new Error('旧版关注任务需要先核实并结束，不能自动迁移到 Outbox');
    console.log(`待关注集合共 ${selected.length} 人，准备写入 Outbox。`);
    const client = new LocalFollowClient();
    const account = await client.selectAccount(state.followAccountId || process.env.X_FOLLOW_ACCOUNT_ID);
    if (!state.followAccountId) { state.followAccountId = account.id; persist('running'); }
    const ids = { ...(state.followTargetIds || {}) };
    for (const candidate of selected) {
      const key = candidate.username.toLowerCase();
      if (!ids[key] && candidate.userId) ids[key] = candidate.userId;
    }
    const missingIds = selected.filter(candidate => !ids[candidate.username.toLowerCase()]);
    if (missingIds.length) {
      stage = 'follow-lookup';
      state.followTargetIds = ids;
      persist('running');
      Object.assign(ids, await client.lookup(account.id, missingIds));
    }
    resilience.resolve(runId, 'follow-lookup');
    stage = 'follow';
    delete state.lookupRetryAt;
    state.followTargetIds = ids;
    persist('running');
    const ready = selected.filter(candidate => ids[candidate.username.toLowerCase()] && ids[candidate.username.toLowerCase()] !== account.id);
    const unresolved = selected.filter(candidate => !ids[candidate.username.toLowerCase()]);
    const outbox = new FollowOutbox('.data/following.sqlite');
    try {
      const added = outbox.enqueue(account.id, ready.map(candidate => ({ id: ids[candidate.username.toLowerCase()], username: candidate.username, source: `${runId}:${state.phase}:${state.post?.url || state.blogger}` })));
      console.log(`Outbox 新增 ${added} 人，重复目标已跳过。`);
    } finally { outbox.close(); }
    state.follow = { matched: ready.map(candidate => ({ username: candidate.username, targetId: ids[candidate.username.toLowerCase()], status: 'queued' })), unresolved: unresolved.map(candidate => candidate.username.toLowerCase()) };
    persist('running');
    {
      const output = join('.data/loop-runs', `${runId}.json`);
      state.results ??= [];
      state.results.push({
        phase: state.phase,
        post: state.phase === 'replies' ? state.post : null,
        export: state.export,
        qualify: state.qualify,
        evaluations: state.evaluations,
        follow: state.follow,
        followSkipped: Boolean(state.followSkipped),
      });
      await writeFile(`${output}.tmp`, JSON.stringify({ runId, target: state.target, blogger: state.blogger, options, posts: state.posts, postIndex: state.postIndex, phase: state.phase, results: state.results }, null, 2), { mode: 0o600 });
      await rename(`${output}.tmp`, output);
      if (!state.followSkipped) markProcessed(state.follow.matched.map(record => ({ username: record.username })));
      if (state.follow.unresolved.length) {
        resilience.failure(runId, 'follow', { kind: 'manual', reason: '部分候选的用户名未能解析为数字 ID', retryable: false });
        persist('incomplete', '部分候选的用户名未能解析为数字 ID');
        console.log(`仍有 ${state.follow.unresolved.length} 人未能解析为数字 ID，保留待处理状态。`);
        break;
      } else {
        resilience.resolve(runId, 'follow');
        if (state.phase === 'replies' && !state.followSkipped) processedPosts.mark(state.followAccountId, state.post?.url, runId);
        if (state.followSkipped) console.log('本批关注已跳过，继续下一批。');
        state.followConfirmation = undefined;
        state.followSkipped = false;
        state.pendingFollowPath = undefined;
        state.export = undefined;
        state.direct = [];
        state.candidates = [];
        state.evaluations = [];
        state.qualify = null;
        state.follow = undefined;
        state.followTargetIds = undefined;
        if (state.singlePost) {
          stage = 'done'; persist('completed');
          console.log(`单帖回复处理完成：${state.singlePostUrl || state.post?.url}；结果 ${output}`);
        } else if (state.phase === 'replies') {
          state.postIndex++;
          if (state.postIndex < state.posts.length) {
            state.post = state.posts[state.postIndex];
            stage = 'export'; persist('running');
            console.log(`转入下一条帖子 ${state.postIndex + 1}/${state.posts.length}：${state.post.url}`);
          } else if (args.noFollowers) {
            stage = 'done'; persist('completed');
            console.log(`所有帖子处理完毕；粉丝任务由定时调度串行处理。结果 ${output}`);
          } else {
            state.phase = 'followers';
            state.post = null;
            stage = 'followers-export'; persist('running');
            console.log('所有帖子处理完毕，转入博主粉丝导出。');
          }
        } else {
          if (state.followerBatch) {
            const checkpoint = followerCheckpoints.get(state.followAccountId, state.blogger);
            followerCheckpoints.save(state.followAccountId, state.blogger, {
              ...checkpoint, offset: state.followerBatch.nextOffset, done: state.followerBatch.done,
              due: Date.now() + FOLLOWER_INTERVAL_MS,
            });
          }
          stage = 'done'; persist('completed');
          console.log(`本轮完成：${state.posts.length} 条帖子 + 博主粉丝；结果 ${output}`);
        }
      }
    }
  }
  }
} catch (error) {
  // 不完整的模型结果仍保存为降级文件，外部操作失败则保留状态等待核实。
  if (runPersisted && runId && state) {
    const classification = classifyFailure(error, stage);
    if (stage === 'follow-lookup' && classification.kind === 'rate_limit') state.lookupRetryAt = error?.retryAt;
    if (stage === 'evaluate' && state.qualify) {
      // Keep qualified users available for review, but do not follow or treat
      // the unassessed users as irrelevant while the model is unavailable.
      const pool = state.qualify.qualifiedCandidates || [];
      const path = join('.data/loop-runs', `${runId}-degraded.json`);
      try {
        await writeFile(`${path}.tmp`, JSON.stringify({ runId, blogger: state.blogger, post: state.post, qualify: state.qualify, direct: state.qualify.qualifiedDirect, evaluated: state.evaluations, unassessed: pool.slice(state.evaluations.length), status: 'manual_review' }, null, 2), { mode: 0o600 });
        await rename(`${path}.tmp`, path);
        state.degradedPath = path;
        console.log(`模型评估未完成，已保存降级结果供人工检查：${path}；未执行关注。`);
      } catch (saveError) { console.error(`无法保存降级文件：${saveError.message}`); }
    }
    try {
      db.exec('BEGIN IMMEDIATE');
      if (stage === 'evaluate' && (classification.kind === 'rate_limit' || classification.kind === 'transient')) resilience.open('llm', classification.reason);
      if (['search', 'export', 'followers-export', 'qualify'].includes(stage) && classification.kind === 'rate_limit') resilience.open('x', classification.reason);
      resilience.failure(runId, stage, classification);
      persist('failed', `${classification.reason}（${classification.kind}）`);
      db.exec('COMMIT');
    } catch (storageError) {
      try { db.exec('ROLLBACK'); } catch { /* BEGIN 失败时没有事务可回滚 */ }
      console.error(`无法保存失败状态：${storageError.message}`);
      // 至少把任务标记为失败，避免状态停在 running 影响后续启动和恢复。
      try {
        db.prepare('UPDATE runs SET status=?, error=?, pid=NULL, updated_at=? WHERE id=?')
          .run('failed', `状态保存失败：${storageError.message}`.slice(0, 300), new Date().toISOString(), runId);
      } catch (markError) { console.error(`无法标记任务失败：${markError.message}`); }
    }
  }
  console.error(`任务停止：${error.message}${runId ? `；任务 ID：${runId}，阶段：${stage}` : ''}`);
  process.exitCode = 1;
} finally {
  if (browser?.isConnected() && !args.keepBrowser) await browser.close();
  db?.close();
  accountStore.close();
  // keep-browser 的 CDP 连接会一直吊着事件循环；共享 Chrome 不能关，只能强制结束本进程。
  if (args.keepBrowser) process.exit(process.exitCode ?? 0);
}
