/** 执行关键词、搜索、导出、筛选、评估和关注的单轮阶段。 */
import 'dotenv/config';
import { connectTestingBrowser } from '../browser/browser-connection.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { bestPost, findPosts, getCollectorPage, scanAndExport } from '../replies/reply-export.ts';
import { partitionReplyCandidates } from '../replies/reply-candidates.ts';
import { makeLlm, generateKeyword, evaluateCandidates } from './loop-llm.ts';
import { LocalFollowClient, followCandidatesApi } from '../follow/api-follow.ts';
import { ResilienceStore, classifyFailure, retryTransient } from './resilience.ts';
import { parseLoopArguments } from './loop-arguments.ts';

let args;
try { args = parseLoopArguments(process.argv.slice(2), true); }
catch (error) { console.error(`参数错误：${error.message}`); process.exit(1); }
const resumeId = args.resumeId;
const target = '寻找对沙特阿拉伯相关公开话题有明确兴趣的用户，仅根据回复内容判断相关性';
let browser, db, state, runId, stage = 'keyword', runPersisted = false;
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
try {
  if (resumeId) {
    const row = db.prepare('SELECT * FROM runs WHERE id=?').get(resumeId);
    if (!row) throw new Error('未找到任务');
    assertNotRunning(row);
    if (row.status === 'completed') throw new Error('该轮已完成');
    if (row.stage === 'export') throw new Error('导出阶段曾中断，无法确认插件是否停止；请先检查 Chrome 中的插件状态');
    runId = row.id; stage = row.stage; state = JSON.parse(row.state); runPersisted = true;
    if (args.accountId && state.followAccountId && args.accountId !== state.followAccountId) throw new Error('恢复任务的授权账号与原任务不一致');
    if (args.username && state.browserUsername && args.username.toLowerCase() !== state.browserUsername.toLowerCase()) throw new Error('恢复任务的浏览器账号与原任务不一致');
    if (state.version !== 3) {
      if (row.stage !== 'profiles' || !state.export?.destination) throw new Error('旧版任务不能自动迁移，请新建一轮');
      state = { target, version: 3, keyword: state.keyword, post: state.post, export: state.export, evaluations: [] };
      stage = 'filter';
    }
    if (args.accountId && !state.followAccountId) {
      if (state.follow) throw new Error('旧浏览器关注任务需要先核对，不能直接绑定 API 账号');
      state.followAccountId = args.accountId;
    }
    if (args.username && !state.browserUsername) state.browserUsername = args.username;
    persist('running');
  } else {
    runId = args.runId || randomUUID(); state = { target, version: 3, evaluations: [], ...(args.accountId ? { followAccountId: args.accountId } : {}), ...(args.username ? { browserUsername: args.username } : {}) };
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
  console.log(`任务 ID：${runId}；当前阶段：${stage}`);
  const llm = makeLlm();
  if (stage === 'keyword') {
    resilience.ensureClosed('llm');
    state.keyword = await retryTransient(() => generateKeyword(llm, state.target));
    resilience.resolve(runId, 'keyword');
    stage = 'search'; persist('running');
    console.log(`模型选择的关键词：${state.keyword}`);
  }
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
  // 只选择前十条中回复数最高且尚未被其他任务处理的帖子。
  if (stage === 'search') {
    const posts = await findPosts(await getPage(), state.keyword, guardX);
    resilience.ensureClosed('x');
    if (posts.some(p => p.replies === null)) throw new Error('有帖子的回复数无法识别，停止选择');
    const oldFiles = await readdir('.data/reply-exports').catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e));
    const oldIds = new Set(oldFiles.map(f => f.match(/^(\d+)-.*\.csv$/)?.[1]).filter(Boolean));
    const available = posts.filter(p => {
      const id = new URL(p.url).pathname.split('/').pop();
      return !oldIds.has(id) && !db.prepare('SELECT id FROM posts WHERE id=?').get(id);
    });
    state.post = bestPost(available);
    if (!state.post || !state.post.replies) throw new Error('前十条中没有可用的新帖子');
    const id = new URL(state.post.url).pathname.split('/').pop();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO posts VALUES (?, ?)').run(id, runId);
      resilience.resolve(runId, 'search');
      stage = 'export'; persist('running');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    console.log(`选择帖子：${state.post.url}，回复数约 ${state.post.replies}`);
  }
  if (stage === 'export') {
    state.export = await scanAndExport(await getPage(), state.post, '.data/reply-exports', guardX);
    resilience.ensureClosed('x');
    resilience.resolve(runId, 'export');
    stage = 'filter'; persist('running');
    console.log(`回复导出 ${state.export.count} 条；停止原因 ${state.export.stoppedWhy || '未知'}`);
  }
  // 文字规则直接保留阿拉伯文字用户，其余交给模型评估。
  if (stage === 'filter') {
    const postId = new URL(state.post.url).pathname.split('/').pop();
    const all = partitionReplyCandidates(await readFile(state.export.destination, 'utf8'), postId);
    const already = db.prepare('SELECT run_id FROM evaluated_users WHERE username=?');
    state.direct = all.direct.filter(c => !already.get(c.username.toLowerCase()));
    state.candidates = all.remaining.filter(c => !already.get(c.username.toLowerCase()));
    state.evaluations = [];
    resilience.resolve(runId, 'filter');
    stage = 'evaluate'; persist('running');
    console.log(`阿拉伯文字直接入选 ${state.direct.length} 人，剩余 ${state.candidates.length} 人交由模型评估；不访问主页。`);
  }
  if (stage === 'evaluate') {
    for (let index = state.evaluations.length; index < state.candidates.length; index += 10) {
      resilience.ensureClosed('llm');
      const result = await retryTransient(() => evaluateCandidates(llm, state.candidates.slice(index, index + 10), state.target));
      state.evaluations.push(...result);
      persist('running');
      console.log(`模型已评估 ${state.evaluations.length}/${state.candidates.length} 人。`);
    }
    const output = join('.data/loop-runs', `${runId}.json`);
    await writeFile(`${output}.tmp`, JSON.stringify({ runId, target: state.target, keyword: state.keyword, post: state.post, export: state.export, direct: state.direct, candidates: state.evaluations }, null, 2), { mode: 0o600 });
    await rename(`${output}.tmp`, output);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const c of [...state.direct, ...state.evaluations]) db.prepare('INSERT OR IGNORE INTO evaluated_users VALUES (?, ?)').run(c.username.toLowerCase(), runId);
      resilience.resolve(runId, 'evaluate');
      state.resultPath = output; stage = 'follow'; persist('running');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  // 将用户名解析为数字 ID，再调用本地授权服务进行 API 关注。
  if (stage === 'follow') {
    const selected = [...state.direct, ...state.evaluations.filter(c => c.decision === 'relevant')];
    if (state.follow && !state.followAccountId) throw new Error('旧浏览器关注任务需要核对已处理和未确认用户，不能直接切换到 API 续跑');
    console.log(`待关注集合共 ${selected.length} 人，通过 X API 处理。`);
    const client = new LocalFollowClient();
    const account = await client.selectAccount(state.followAccountId || process.env.X_FOLLOW_ACCOUNT_ID);
    if (!state.followAccountId) { state.followAccountId = account.id; persist('running'); }
    if (!state.followTargetIds) {
      ensureX();
      state.followTargetIds = await client.lookup(account.id, selected);
      persist('running');
    }
    state.follow = await followCandidatesApi({ client, accountId: account.id, candidates: selected, ids: state.followTargetIds,
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
    await writeFile(`${output}.tmp`, JSON.stringify({ runId, target: state.target, keyword: state.keyword, post: state.post, export: state.export, direct: state.direct, candidates: state.evaluations, follow: state.follow }, null, 2), { mode: 0o600 });
    await rename(`${output}.tmp`, output);
    if (state.follow.unresolved.length) {
      resilience.failure(runId, 'follow', { kind: 'manual', reason: '部分候选的回复未在页面上找到', retryable: false });
      persist('incomplete', '部分候选的回复未在页面上找到');
      console.log(`仍有 ${state.follow.unresolved.length} 人未在页面找到，保留待处理状态。`);
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
    if (stage === 'evaluate' && Array.isArray(state.direct) && Array.isArray(state.candidates)) {
      // Keep language matches available for review, but do not follow or treat
      // the unassessed users as irrelevant while the model is unavailable.
      const path = join('.data/loop-runs', `${runId}-degraded.json`);
      try {
        await writeFile(`${path}.tmp`, JSON.stringify({ runId, post: state.post, direct: state.direct, evaluated: state.evaluations, unassessed: state.candidates.slice(state.evaluations.length), status: 'manual_review' }, null, 2), { mode: 0o600 });
        await rename(`${path}.tmp`, path);
        state.degradedPath = path;
        console.log(`模型评估未完成，已保存降级结果供人工检查：${path}；未执行关注。`);
      } catch (saveError) { console.error(`无法保存降级文件：${saveError.message}`); }
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      if (['keyword', 'evaluate'].includes(stage) && (classification.kind === 'rate_limit' || classification.kind === 'transient')) resilience.open('llm', classification.reason);
      if (['search', 'export', 'follow'].includes(stage) && classification.kind === 'rate_limit') resilience.open('x', classification.reason);
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
}
