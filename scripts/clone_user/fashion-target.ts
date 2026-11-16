/** 未指定 --target 时，用 X API 搜索时尚相关博主并检查最近帖子的回复量。 */
export type FashionCandidate = {
  id: string;
  username: string;
  name?: string;
  followers: number;
  description?: string;
};

export type FashionEvaluation = {
  pass: boolean;
  qualifyingPosts: number;
  reason: string;
};

/** 纯规则：粉丝数必须大于阈值，最近 N 条中至少 M 条回复数达标。 */
export function evaluateFashionCandidate({
  followers,
  replyCounts,
  minFollowers,
  minReplies,
  requiredPosts,
}: {
  followers: number;
  replyCounts: number[];
  minFollowers: number;
  minReplies: number;
  requiredPosts: number;
}): FashionEvaluation {
  if (!Number.isFinite(followers) || followers <= minFollowers) {
    return { pass: false, qualifyingPosts: 0, reason: `粉丝数 ${followers} 不大于 ${minFollowers}` };
  }
  if (replyCounts.length < 3) {
    return { pass: false, qualifyingPosts: 0, reason: '最近帖子不足 3 条' };
  }
  const qualifyingPosts = replyCounts.slice(0, 3).filter((count) => count >= minReplies).length;
  if (qualifyingPosts < requiredPosts) {
    return { pass: false, qualifyingPosts, reason: `最近 3 条中只有 ${qualifyingPosts} 条回复数达到 ${minReplies}` };
  }
  return { pass: true, qualifyingPosts, reason: '通过' };
}

type DiscoverOptions = {
  accountId: string;
  origin: string;
  queries?: string[];
  minReplies?: number;
  minFollowers?: number;
  requiredPosts?: number;
  maxCandidates?: number;
  fetchImpl?: typeof fetch;
};

const DEFAULT_QUERIES = ['fashion', 'fashion blogger', 'fashion influencer', 'ootd', 'street style'];

/** 搜索候选并逐条读取最近 5 条原帖，返回第一个满足规则的博主用户名。 */
export async function discoverFashionTarget({
  accountId,
  origin,
  queries = DEFAULT_QUERIES,
  minReplies = 50,
  minFollowers = 1000,
  requiredPosts = 2,
  maxCandidates = 40,
  fetchImpl = fetch,
}: DiscoverOptions): Promise<string> {
  const seen = new Set<string>();
  let examined = 0;
  for (const query of queries) {
    const searchUrl = `${origin}/api/accounts/${accountId}/search?${new URLSearchParams({ query })}`;
    const searchResponse = await fetchImpl(searchUrl, { headers: { 'X-Local-Request': '1' } });
    const searchPayload = await searchResponse.json().catch(() => ({}));
    if (!searchResponse.ok) throw new Error(`搜索时尚博主失败：${searchPayload.error || `HTTP ${searchResponse.status}`}`);
    const users = Array.isArray(searchPayload.data) ? searchPayload.data : [];
    for (const user of users) {
      if (examined >= maxCandidates) break;
      if (!user || typeof user.id !== 'string' || !/^\d{1,19}$/.test(user.id)) continue;
      if (!user.username || !/^[A-Za-z0-9_]{1,15}$/.test(user.username)) continue;
      if (user.id === accountId || seen.has(user.id)) continue;
      seen.add(user.id);
      const followers = Number(user.public_metrics?.followers_count ?? 0);
      if (!(followers > minFollowers)) continue;
      examined++;
      const timelineUrl = `${origin}/api/accounts/${accountId}/users/${user.id}/tweets?${new URLSearchParams({
        max_results: '5',
        exclude: 'retweets,replies',
        'tweet.fields': 'public_metrics,created_at',
      })}`;
      const timelineResponse = await fetchImpl(timelineUrl, { headers: { 'X-Local-Request': '1' } });
      const timelinePayload = await timelineResponse.json().catch(() => ({}));
      if (!timelineResponse.ok) {
        console.log(`检查 @${user.username} 失败：${timelinePayload.error || `HTTP ${timelineResponse.status}`}`);
        continue;
      }
      const replies = (Array.isArray(timelinePayload.data) ? timelinePayload.data : [])
        .slice(0, 3)
        .map((tweet: { public_metrics?: { reply_count?: number } }) => Number(tweet.public_metrics?.reply_count ?? 0));
      const evaluation = evaluateFashionCandidate({
        followers,
        replyCounts: replies,
        minFollowers,
        minReplies,
        requiredPosts,
      });
      console.log(`时尚候选 @${user.username}：粉丝 ${followers}，最近回复 [${replies.join(', ')}] -> ${evaluation.reason}`);
      if (evaluation.pass) {
        console.log(`自动选择时尚博主 @${user.username}（${user.id}）。`);
        return user.username;
      }
    }
    if (examined >= maxCandidates) break;
  }
  throw new Error(`未找到满足条件的时尚博主（粉丝 > ${minFollowers}，最近 3 条至少 ${requiredPosts} 条回复 >= ${minReplies}）；请用 --target 指定`);
}

/** 解析逗号分隔的搜索词；保留 X 用户搜索允许的字符。 */
export function parseFashionQueries(value: string | undefined): string[] {
  if (!value) return DEFAULT_QUERIES;
  const queries = value.split(',').map((item) => item.trim()).filter(Boolean);
  const valid = queries.filter((query) => /^[A-Za-z0-9_' ]{1,50}$/.test(query));
  return valid.length ? valid : DEFAULT_QUERIES;
}
