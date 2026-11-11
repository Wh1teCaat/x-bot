/** 实现备用粉丝流程中的单次关注选择。 */
import { rankUsers } from "./user-ranking.ts";

type User = { id: string; username?: string; description?: string; location?: string; connection_status?: string[]; public_metrics?: { followers_count?: number } };
type Result = { data?: User[]; errors?: unknown[]; meta?: { next_token?: string } };
type Dependencies = {
  search: () => Promise<Result>;
  followers: (id: string, nextToken?: string) => Promise<Result>;
  knownStatus: (id: string) => string | undefined;
  follow: (id: string) => Promise<unknown>;
};

/** 选择首个符合条件且状态已知的粉丝，最多提交一次关注。 */
export async function followFirstArabFollower(accountId: string, deps: Dependencies) {
  const search = await deps.search();
  if (search.errors?.length || (search.data !== undefined && !Array.isArray(search.data)))
    return { status: "incomplete", stage: "search", reason: "搜索结果不完整，未执行关注。", search };
  if (!search.data?.length)
    return { status: "empty", stage: "search", reason: "搜索结果为空，未执行关注。", search };
  if (search.data.some((user) => !user || typeof user.id !== "string" || !/^\d{1,19}$/.test(user.id)))
    return { status: "incomplete", stage: "search", reason: "搜索结果包含无效用户，未执行关注。", search };
  const blogger = rankUsers(search.data, (user) => user)[0];
  const visitedTokens = new Set<string>();
  let nextToken: string | undefined;
  let skipped = 0;
  for (let page = 0; page < 10; page++) {
    const followers = await deps.followers(blogger.id, nextToken);
    if (followers.errors?.length || (followers.data !== undefined && !Array.isArray(followers.data)))
      return { status: "incomplete", stage: "followers", reason: "粉丝结果不完整，未执行关注。", blogger, followers, skipped };
    const follower = followers.data?.[0];
    if (follower) {
      if (typeof follower.id !== "string" || !/^\d{1,19}$/.test(follower.id))
        return { status: "incomplete", stage: "followers", reason: "粉丝 ID 无效，未执行关注。", blogger, follower, skipped };
      if (follower.id !== accountId) {
        const relations = follower.connection_status;
        if (relations !== undefined && (!Array.isArray(relations) || !relations.every((value) => typeof value === "string")))
          return { status: "incomplete", stage: "followers", reason: "X 未返回有效的关注关系，无法确认是否已关注，未执行关注。", blogger, follower, skipped };
        if (!deps.knownStatus(follower.id) && !relations?.includes("following") && !relations?.includes("follow_request_sent")) {
          const follow = await deps.follow(follower.id);
          return { status: "follow_requested", blogger, follower, follow, skipped };
        }
      }
      skipped++;
    }
    const token = followers.meta?.next_token;
    if (token === undefined)
      return { status: "empty", stage: "followers", reason: "没有更多可关注的粉丝。", blogger, skipped };
    if (typeof token !== "string" || !token || visitedTokens.has(token))
      return { status: "incomplete", stage: "followers", reason: "粉丝分页信息无效或重复，未执行关注。", blogger, skipped };
    visitedTokens.add(token);
    nextToken = token;
  }
  return { status: "limit", stage: "followers", reason: "已检查 10 页粉丝，尚未找到可关注的账号，未执行关注。", blogger, skipped };
}
