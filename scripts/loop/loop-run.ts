/** 执行博主帖子采集、导出、固定规则筛选、可选评估和关注的单轮阶段。 */
import 'dotenv/config';
import { connectTestingBrowser } from '../browser/browser-connection.ts';
import { actionDelay, createProfileVisitDelay } from '../browser/action-delay.ts';
import { openExporter24, readExporter24Counts } from '../browser/exporter24.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { bestPost, findBloggerPosts, getCollectorPage, scanAndExport } from '../replies/reply-export.ts';
import { enrichCsv, partitionReplyCandidates } from '../replies/reply-candidates.ts';
import { readProfileCounts } from '../replies/profile-counts.ts';
import { qualifyByFollowerBalance } from '../replies/follower-filter.ts';
import { makeLlm, evaluateCandidates } from './loop-llm.ts';
import { LocalFollowClient, followCandidatesApi } from '../follow/api-follow.ts';
import { ResilienceStore, classifyFailure, retryTransient } from './resilience.ts';
import { parseLoopArguments } from './loop-arguments.ts';
import { AccountStore } from '../../src/account-store.ts';

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
let blogger = args.blogger || clonedBlogger();
await mkdir('.data/loop-runs', { recursive: true });
db = new DatabaseSync('.data/loop.sqlite');
db.exec(`CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, status TEXT NOT NULL, stage TEXT NOT NULL, state TEXT NOT NULL, error TEXT, pid INTEGER, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS posts(id TEXT PRIMARY KEY, run_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS evaluated_users(username TEXT PRIMARY KEY, run_id TEXT NOT NULL);`);
const resilience = new ResilienceStore(db);
const followProbe = args.followProbe;
/** 只允许对应任务在半开状态下执行受控关注探测。 */
const ensureX = () => {
  const circuit = resilience.circuit('x');
  if (followProbe && stage === 'follow' && circuit?.state === 'half_open') return;
  if (circuit?.state === 'half_open') throw new Error('X 熔断处于半开探测中');
  resilience.ensureClosed('x');
};
/** 每个阶段完成后保存任务状态，供失败或进程重启后恢复。 */
const persist = (status, error = null) => db.prepare('UPDATE runs SET status=?, stage=?, state=?, error=?, pid=?, updated_at=? WHERE id=?')
  .run(status, stage, JSON.stringify(state), error, status === 'running' ? process.pid : null, new Date().toISOString(), runId);
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
    if (row.stage === 'export') throw new Error('导出阶段曾中断，无法确认插件是否停止；请先检查 Chrome 中的插件状态');
    runId = row.id; stage = row.stage; state = JSON.parse(row.state); runPersisted = true;
    if (state.version !== 4) throw new Error('旧版任务不能自动迁移，请新建一轮');
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
    options = { language: args.language ?? null, evaluate: args.evaluate };
    runId = args.runId || randomUUID();
    state = {
      target: targetFor(blogger), version: 4, blogger, options, evaluations: [],
      ...(args.accountId ? { followAccountId: args.accountId } : {}),
      ...(args.username ? { browserUsername: args.username } : {}),
    };
    // 当前去重与熔断仍为全局状态，先原子地限制为同一时刻只执行一轮。
    db.exec('BEGIN IMMEDIATE');
    try {
      // 冷却中的存活队列同样占用全局熔断；其他账号暂不并行探测。
      for (const job of db.prepare("SELECT owner_pid FROM loop_jobs WHERE id<>? AND status IN ('running','cooldown') AND owner_pid IS NOT NULL").all(runId)) {
        try { process.kill(Number(job.owner_pid), 0); throw new Error('已有其他账号的任务运行或冷却，当前版本不支持并行'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      for (const row of db.prepare("SELECT * FROM runs WHERE status='running'").all()) assertNotRunning(row);
      db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, NULL, ?, ?)').run(runId, 'running', stage, JSON.stringify(state), process.pid, new Date().toISOString());
      db.exec('COMMIT');
      runPersisted = true;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  console.log(`任务 ID：${runId}；博主：@${state.blogger}；当前阶段：${stage}`);
  // 只有真正进入可选模型评估阶段才要求模型配置。
  let llm;
  const getLlm = () => llm || (llm = makeLlm());
  let page;
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
        if (response.status() === 429 && (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com'))) resilience.open('x', 'X 返回 HTTP 429');
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
  // 只选择该博主主页中回复数最高且尚未被其他任务处理的帖子。
  if (stage === 'search') {
    const posts = await findBloggerPosts(await getPage(), state.blogger, guardX);
    resilience.ensureClosed('x');
    if (posts.some(p => p.replies === null)) throw new Error('有帖子的回复数无法识别，停止选择');
    const oldFiles = await readdir('.data/reply-exports').catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e));
    const oldIds = new Set(oldFiles.map(f => f.match(/^(\d+)-.*\.csv$/)?.[1]).filter(Boolean));
    const available = posts.filter(p => {
      const id = new URL(p.url).pathname.split('/').pop();
      return !oldIds.has(id) && !db.prepare('SELECT id FROM posts WHERE id=?').get(id);
    });
    state.post = bestPost(available);
    if (!state.post || !state.post.replies) throw new Error(`博主 @${state.blogger} 的帖子中没有可用的新帖子`);
    const id = new URL(state.post.url).pathname.split('/').pop();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO posts VALUES (?, ?)').run(id, runId);
      resilience.resolve(runId, 'search');
      stage = 'export'; persist('running');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    console.log(`选择博主 @${state.blogger} 的帖子：${state.post.url}，回复数约 ${state.post.replies}`);
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
    console.log(`回复导出 ${state.export.count} 条；停止原因 ${state.export.stoppedWhy || '未知'}`);
  }
  // 解析回复中的用户；语言筛选是可选路径，默认全部交给固定规则。
  if (stage === 'filter') {
    const postId = new URL(state.post.url).pathname.split('/').pop();
    const all = partitionReplyCandidates(await readFile(state.export.destination, 'utf8'), postId);
    const already = db.prepare('SELECT run_id FROM evaluated_users WHERE username=?');
    const keep = candidate => candidate.username.toLowerCase() !== state.blogger.toLowerCase() && !already.get(candidate.username.toLowerCase());
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
    state.evaluations = [];
    state.qualify = null;
    const missingCounts = [...state.direct, ...state.candidates].filter(c => c.followers === undefined || c.following === undefined).length;
    console.log(`CSV 关注/粉丝数：${all.hasFollowerCounts ? '已包含' : '未包含'}；${missingCounts} 人需要通过 exporter24 或主页读取。`);
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
      try { exporterPage = await openExporter24(page.context()); } catch { exporterPage = null; }
      if (exporterPage) {
        console.log(`检测到 exporter24，用扩展读取 ${needCounts.length} 人的关注/粉丝数。`);
        let consecutiveFailures = 0;
        try {
          for (let index = 0; index < needCounts.length; index++) {
            const candidate = needCounts[index];
            if (hasBoth(candidate)) continue;
            const key = candidate.username.toLowerCase();
            await guardX();
            await actionDelay(exporterPage);
            try {
              const counts = await readExporter24Counts(exporterPage, candidate.username, guardX);
              consecutiveFailures = 0;
              state.profileCounts[key] = counts;
              if (counts.followers !== undefined) candidate.followers = counts.followers;
              if (counts.following !== undefined) candidate.following = counts.following;
              if ((index + 1) % 10 === 0 || !hasBoth(candidate)) {
                console.log(`exporter24 ${index + 1}/${needCounts.length}：@${candidate.username} 粉丝 ${counts.followers ?? '未知'}，关注 ${counts.following ?? '未知'}。`);
              }
            } catch (error) {
              if (resilience.circuit('x')?.state === 'open') throw error;
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
        console.log('未检测到 exporter24 扩展，改用主页读取。');
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
    try {
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
    const hasModelPool = options.evaluate && qualifiedCandidates.length > 0;
    stage = hasModelPool ? 'evaluate' : 'follow';
    if (!hasModelPool) markProcessed([...qualifiedDirect, ...qualifiedCandidates]);
    persist('running');
    console.log(`固定规则（关注和粉丝均大于 50、相差不超过 2 倍）入选 ${qualifiedDirect.length + qualifiedCandidates.length} 人，排除 ${rejected.length} 人。`);
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
    markProcessed([...state.qualify.qualifiedDirect, ...state.evaluations]);
    resilience.resolve(runId, 'evaluate');
    state.resultPath = output; stage = 'follow'; persist('running');
  }
  // 使用固定规则入选的用户调用本地授权服务进行 API 关注。
  if (stage === 'follow') {
    const selected = [...(state.qualify?.qualifiedDirect || []), ...state.evaluations.filter(c => c.decision === 'relevant')];
    if (state.follow && !state.followAccountId) throw new Error('旧浏览器关注任务需要核对已处理和未确认用户，不能直接切换到 API 续跑');
    console.log(`待关注集合共 ${selected.length} 人，通过 X API 处理。`);
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
      ensureX();
      Object.assign(ids, await client.lookup(account.id, missingIds));
      persist('running');
    }
    state.followTargetIds = ids;
    persist('running');
    state.follow = await followCandidatesApi({ client, accountId: account.id, candidates: selected, ids,
      progress: state.follow, guard: ensureX,
      save: async progress => { state.follow = progress; persist('running'); },
      ...(followProbe ? { maxNewFollows: 1 } : {}),
    });
    if (followProbe) {
      ensureX();
      if (!state.follow.probeSucceeded) throw new Error('未能找到可探测的新关注用户');
      persist('probe_succeeded');
      console.log('单次关注探测已确认成功。');
      process.exitCode = 0;
    } else {
    const output = join('.data/loop-runs', `${runId}.json`);
    await writeFile(`${output}.tmp`, JSON.stringify({ runId, target: state.target, blogger: state.blogger, options, post: state.post, export: state.export, qualify: state.qualify, direct: state.qualify?.qualifiedDirect || [], candidates: state.evaluations, follow: state.follow }, null, 2), { mode: 0o600 });
    await rename(`${output}.tmp`, output);
    if (state.follow.unresolved.length) {
      resilience.failure(runId, 'follow', { kind: 'manual', reason: '部分候选的用户名未能解析为数字 ID', retryable: false });
      persist('incomplete', '部分候选的用户名未能解析为数字 ID');
      console.log(`仍有 ${state.follow.unresolved.length} 人未能解析为数字 ID，保留待处理状态。`);
    } else {
      resilience.resolve(runId, 'follow');
      stage = 'done'; persist('completed');
      console.log(`本轮完成，处理 ${state.follow.matched.length} 位用户；结果 ${output}`);
    }
    }
  }
} catch (error) {
  // 不完整的模型结果仍保存为降级文件，外部操作失败则保留状态等待核实。
  if (runPersisted && runId && state) {
    const classification = classifyFailure(error, stage);
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
    db.exec('BEGIN IMMEDIATE');
    try {
      if (stage === 'evaluate' && (classification.kind === 'rate_limit' || classification.kind === 'transient')) resilience.open('llm', classification.reason);
      if (['search', 'export', 'qualify', 'follow'].includes(stage) && classification.kind === 'rate_limit') resilience.open('x', classification.reason);
      resilience.failure(runId, stage, classification);
      persist('failed', `${classification.reason}（${classification.kind}）`);
      db.exec('COMMIT');
    } catch (storageError) {
      db.exec('ROLLBACK');
      console.error(`无法保存失败状态：${storageError.message}`);
    }
  }
  console.error(`任务停止：${error.message}${runId ? `；任务 ID：${runId}，阶段：${stage}` : ''}`);
  process.exitCode = 1;
} finally {
  if (browser?.isConnected()) await browser.close();
  db?.close();
  accountStore.close();
}
