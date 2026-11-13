/** 固定规则：关注与粉丝都大于 50，且两者相差不超过两倍。 */
export const MIN_FOLLOW_COUNT = 50;
export const MAX_FOLLOW_RATIO = 2;

type Metrics = {
  followers_count?: unknown;
  following_count?: unknown;
};

export type FollowerBalance = {
  eligible: boolean;
  followers?: number;
  following?: number;
  reason?: string;
};

export type CandidateWithCounts = {
  username: string;
  followers?: unknown;
  following?: unknown;
  [key: string]: unknown;
};

export type QualifiedCandidate = CandidateWithCounts & {
  followers: number;
  following: number;
};

export type RejectedCandidate = {
  username: string;
  followers?: number;
  following?: number;
  reason: string;
};

/** 读取非负整数计数；缺失或格式异常时返回 undefined。 */
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** 按固定规则判断一组关注数据是否合格。 */
export function followerBalance(value: unknown): FollowerBalance {
  const metrics =
    value !== null && typeof value === "object" ? (value as Metrics) : {};
  const followers = count(metrics.followers_count);
  const following = count(metrics.following_count);
  if (followers === undefined || following === undefined)
    return { eligible: false, followers, following, reason: "缺少关注数或粉丝数" };
  if (followers <= MIN_FOLLOW_COUNT || following <= MIN_FOLLOW_COUNT)
    return {
      eligible: false,
      followers,
      following,
      reason: `关注数和粉丝数都必须大于 ${MIN_FOLLOW_COUNT}`,
    };
  if (Math.max(followers, following) > Math.min(followers, following) * MAX_FOLLOW_RATIO)
    return {
      eligible: false,
      followers,
      following,
      reason: `关注数与粉丝数相差超过 ${MAX_FOLLOW_RATIO} 倍`,
    };
  return { eligible: true, followers, following };
}

/** 将 CSV 候选分为入选和排除两组，保留候选原有顺序和其余字段。 */
export function qualifyByFollowerBalance(
  candidates: CandidateWithCounts[],
): {
  qualified: QualifiedCandidate[];
  rejected: RejectedCandidate[];
} {
  const qualified: QualifiedCandidate[] = [];
  const rejected: RejectedCandidate[] = [];
  for (const candidate of candidates) {
    const balance = followerBalance({
      followers_count: candidate.followers,
      following_count: candidate.following,
    });
    if (balance.eligible)
      qualified.push({
        ...candidate,
        followers: balance.followers!,
        following: balance.following!,
      });
    else
      rejected.push({
        username: candidate.username,
        followers: balance.followers,
        following: balance.following,
        reason: balance.reason!,
      });
  }
  return { qualified, rejected };
}
