/** 通过本地授权服务解析用户并使用 X API 处理关注。 */
/** 判断输入是否为合法的 X 数字用户 ID。 */
const validId = (value: unknown): value is string => typeof value === 'string' && /^\d{1,19}$/.test(value);
/** 判断输入是否为有效的 X 用户名。 */
const validName = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(value);

export type FollowCandidate = { username: string };
export type FollowRecord = { username: string; targetId?: string; status: 'following' | 'pending' };
export type FollowProgress = { matched: FollowRecord[]; unresolved: string[]; probeSucceeded?: boolean };
type FollowResponse = { data?: { following?: boolean; pending_follow?: boolean }; errors?: unknown[]; cached?: boolean };
type FollowClient = { follow: (accountId: string, targetId: string) => Promise<FollowResponse> };

/** 封装仅连接本机授权服务的关注客户端。 */
export class LocalFollowClient {
  origin: string;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  /** 验证本地端口并初始化可替换的请求与等待依赖。 */
  constructor({ port = process.env.PORT || '3000', fetchImpl = fetch, sleep = ms => new Promise<void>(resolve => setTimeout(resolve, ms)), random = Math.random } = {}) {
    if (!/^\d{1,5}$/.test(String(port)) || +port < 1 || +port > 65535) throw new Error('PORT 无效');
    this.origin = `http://127.0.0.1:${port}`; this.fetch = fetchImpl; this.sleep = sleep; this.random = random;
  }
  /** 请求本地服务，保留 HTTP 状态以便识别限流。 */
  async request(path, method = 'GET') {
    let response;
    try { response = await this.fetch(`${this.origin}${path}`, { method, headers: { 'X-Local-Request': '1', ...(method === 'POST' ? { Origin: this.origin } : {}) }, signal: AbortSignal.timeout(20000) }); }
    catch { throw new Error('无法连接本地授权服务，请先运行 npm start；如关注请求已发出，请核实结果'); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || `本地服务错误 (${response.status})`) as Error & { status: number; retryAfter: string | null };
      error.status = response.status; error.retryAfter = response.headers.get('retry-after'); throw error;
    }
    return body;
  }
  /** 选择并固定具备关注权限的授权账号。 */
  async selectAccount(preferred?: string) {
    const result = await this.request('/api/accounts');
    const accounts = (result.accounts || []).filter(a => validId(a.user?.id) && (a.scope || '').split(/\s+/).includes('follows.write'));
    if (preferred && !validId(preferred)) throw new Error('X_FOLLOW_ACCOUNT_ID 必须是授权账号的数字 ID');
    const found = preferred ? accounts.find(a => a.user.id === preferred) : accounts.length === 1 ? accounts[0] : null;
    if (!found) throw new Error(accounts.length > 1 && !preferred ? '存在多个授权账号，请配置 X_FOLLOW_ACCOUNT_ID' : '没有可用的关注授权，请打开授权页面并重新授权');
    return found.user;
  }
  /** 分批解析候选用户名，拒绝不符合预期的身份响应。 */
  async lookup(accountId: string, candidates: FollowCandidate[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (let i = 0; i < candidates.length; i += 100) {
      const names = candidates.slice(i, i + 100).map(c => c.username);
      if (names.some(name => !validName(name))) throw new Error('候选用户名无效');
      await this.sleep(Math.floor(this.random() * 1001));
      const response = await this.request(`/api/accounts/${accountId}/users/by?${new URLSearchParams({ usernames: names.join(',') })}`);
      if (!Array.isArray(response.data) && !Array.isArray(response.errors)) throw new Error('用户查询结果不完整');
      const wanted = new Set(names.map(n => n.toLowerCase()));
      for (const user of response.data || []) {
        if (!validId(user.id) || !validName(user.username) || !wanted.has(user.username.toLowerCase())) throw new Error('用户查询返回无效身份');
        result[user.username.toLowerCase()] = user.id;
      }
    }
    return result;
  }
  /** 向本地服务提交一个目标用户的关注请求。 */
  async follow(accountId, targetId) {
    if (!validId(accountId) || !validId(targetId)) throw new Error('账号 ID 无效');
    await this.sleep(Math.floor(this.random() * 1001));
    return this.request(`/api/accounts/${accountId}/users/${targetId}/follow`, 'POST');
  }
}

/** 跳过已完成用户，逐个关注并在每次结果确认后保存断点。 */
export async function followCandidatesApi({ client, accountId, candidates, ids, progress, save, guard = () => {}, maxNewFollows = Infinity, sleep = ms => new Promise<void>(resolve => setTimeout(resolve, ms)), random = Math.random }: {
  client: FollowClient; accountId: string; candidates: FollowCandidate[]; ids: Record<string, string>;
  progress?: Pick<FollowProgress, 'matched'> & Partial<Pick<FollowProgress, 'unresolved'>>; save: (progress: FollowProgress) => Promise<unknown>; guard?: () => void | Promise<void>;
  maxNewFollows?: number; sleep?: (ms: number) => Promise<void>; random?: () => number;
}): Promise<FollowProgress> {
  const matched = [...(progress?.matched || [])];
  const completed = new Set(matched.map(c => c.username.toLowerCase()));
  const remaining = candidates.filter(c => !completed.has(c.username.toLowerCase()));
  let processed = 0;
  for (const candidate of [...remaining]) {
    const key = candidate.username.toLowerCase(), targetId = ids[key];
    if (!targetId || targetId === accountId) continue;
    await guard();
    const result = await client.follow(accountId, targetId);
    const status = result.data?.following === true ? 'following' : result.data?.pending_follow === true ? 'pending' : null;
    if (!status || result.errors?.length) throw new Error(`@${candidate.username} 的关注结果不明确，请先核实`);
    matched.push({ username: candidate.username, targetId, status });
    remaining.splice(remaining.indexOf(candidate), 1);
    await save({ matched, unresolved: remaining.map(c => c.username.toLowerCase()) });
    console.log(`@${candidate.username}：${status}；剩余 ${remaining.length} 人。`);
    if (!result.cached && --maxNewFollows === 0) return { matched, unresolved: remaining.map(c => c.username.toLowerCase()), probeSucceeded: true };
    if (++processed % 10 === 0) await sleep(Math.floor(random() * 5001));
  }
  return { matched, unresolved: remaining.map(c => c.username.toLowerCase()) };
}
