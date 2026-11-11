/** 基于公开资料与有限的语言样本筛选候选账号。 */
export const SAUDI_KEYWORDS = [
  "Saudi",
  "Saudi Arabia",
  "Riyadh",
  "Jeddah",
  "Dammam",
];

const locationTerms = [
  "saudi",
  "ksa",
  "السعودية",
  "الرياض",
  "riyadh",
  "جدة",
  "jeddah",
  "الدمام",
  "dammam",
  "مكة",
  "makkah",
  "mecca",
  "المدينة",
  "madinah",
  "medina",
];

const maxPagesPerKeyword = 2;
const maxTimelineRequests = 10;

type Candidate = {
  id: string;
  location?: string;
  [key: string]: unknown;
};

type CandidateItem = {
  user: Candidate;
  keywords: string[];
  language_evidence?: ReturnType<typeof languageEvidence>;
  reason?: string;
  status?: number;
};

type DiscoveryResult = {
  status: "error" | "undetermined" | "matched" | "empty";
  stage?: "search";
  error?: { status?: number; message: string };
  reason?: string;
  search_summary: { keyword: string; pages: number; truncated: boolean }[];
  search_requests: number;
  timeline_requests: number;
  data: CandidateItem[];
  scanned_unique?: number;
  location_matched?: number;
  search_truncated?: boolean;
  undetermined?: CandidateItem[];
  rate_limited?: boolean;
  level?: number | null;
};

type SearchResponse = {
  data?: Candidate[];
  meta?: { next_token?: string };
  errors?: unknown[];
};

type TimelinePost = {
  lang?: string;
  referenced_tweets?: { type?: string }[];
  referenced_posts?: { type?: string }[];
};

type TimelineResponse = {
  data?: TimelinePost[];
  meta?: { next_token?: string };
  errors?: unknown[];
};

type DiscoveryDependencies = {
  search: (keyword: string, nextToken?: string) => Promise<SearchResponse>;
  timeline: (id: string) => Promise<TimelineResponse>;
};

/** 提取可用于分类和展示的请求错误信息。 */
function errorInfo(error: unknown) {
  const value = error as { status?: number; message?: string };
  return { status: value?.status, message: value?.message || "读取失败" };
}

/** 检查用户公开地区是否包含目标地区线索。 */
function matchesLocation(user: Candidate) {
  if (typeof user.location !== "string") return false;
  const location = user.location.toLowerCase();
  return locationTerms.some((term) => location.includes(term));
}

/** 根据有限的近期帖子样本统计语言线索。 */
function languageEvidence(timeline: TimelineResponse) {
  const posts = Array.isArray(timeline.data) ? timeline.data : [];
  const stats = {
    sampled: posts.length,
    arabic_posts: 0,
    arabic_replies: 0,
    other_language: 0,
    unknown_language: 0,
  };

  for (const post of posts) {
    if (post.lang === "ar") {
      const refs = post.referenced_tweets || post.referenced_posts || [];
      if (refs.some((ref) => ref.type === "replied_to")) stats.arabic_replies++;
      else stats.arabic_posts++;
    } else if (post.lang && post.lang !== "und") {
      stats.other_language++;
    } else {
      stats.unknown_language++;
    }
  }

  const matched = stats.arabic_posts + stats.arabic_replies > 0;
  const uncertain =
    !matched &&
    (!posts.length ||
      stats.unknown_language > 0 ||
      Boolean(timeline.errors?.length));
  return {
    stats,
    matched,
    uncertain,
    timeline_has_more: Boolean(timeline.meta?.next_token),
  };
}

/** 执行有限页搜索并按资料和语言证据分级返回候选。 */
export async function discoverSaudiAccount(deps: DiscoveryDependencies): Promise<DiscoveryResult> {
  const candidates = new Map<string, { user: Candidate; keywords: string[] }>();
  const searchSummary: {
    keyword: string;
    pages: number;
    truncated: boolean;
  }[] = [];
  let searchRequests = 0;
  let timelineRequests = 0;

  for (const keyword of SAUDI_KEYWORDS) {
    let nextToken: string | undefined;
    const summary = { keyword, pages: 0, truncated: false };
    searchSummary.push(summary);

    for (let page = 0; page < maxPagesPerKeyword; page++) {
      let result: SearchResponse;
      try {
        searchRequests++;
        result = await deps.search(keyword, nextToken);
      } catch (error) {
        return {
          status: "error",
          stage: "search",
          error: errorInfo(error),
          search_summary: searchSummary,
          search_requests: searchRequests,
          timeline_requests: timelineRequests,
          data: [],
        };
      }
      summary.pages++;
      if (
        result.errors?.length ||
        (result.data !== undefined && !Array.isArray(result.data)) ||
        (!result.data && !result.meta)
      ) {
        return {
          status: "undetermined",
          stage: "search",
          reason: "X 返回了部分错误或无法识别的搜索结果，未执行降级",
          search_summary: searchSummary,
          search_requests: searchRequests,
          timeline_requests: timelineRequests,
          data: [],
        };
      }

      for (const user of result.data || []) {
        if (typeof user.id !== "string" || !/^\d{1,19}$/.test(user.id)) {
          return {
            status: "undetermined",
            stage: "search",
            reason: "搜索结果包含无效用户 ID，未执行降级",
            search_summary: searchSummary,
            search_requests: searchRequests,
            timeline_requests: timelineRequests,
            data: [],
          };
        }
        const previous = candidates.get(user.id);
        if (previous) {
          if (!previous.keywords.includes(keyword))
            previous.keywords.push(keyword);
        } else {
          candidates.set(user.id, { user, keywords: [keyword] });
        }
      }
      nextToken = result.meta?.next_token;
      if (!nextToken) break;
      if (page === maxPagesPerKeyword - 1) summary.truncated = true;
    }
  }

  const all = [...candidates.values()];
  const locationMatches = all.filter(({ user }) => matchesLocation(user));
  const matched: CandidateItem[] = [];
  const unknown: CandidateItem[] = [];
  let rateLimited = false;

  for (const candidate of locationMatches) {
    if (rateLimited || timelineRequests >= maxTimelineRequests) {
      unknown.push({
        ...candidate,
        reason: rateLimited ? "请求限流，未读取" : "已达到帖子读取上限",
      });
      continue;
    }
    try {
      timelineRequests++;
      const timeline = await deps.timeline(candidate.user.id);
      if (
        (timeline.data !== undefined && !Array.isArray(timeline.data)) ||
        (!timeline.data && !timeline.meta && !timeline.errors?.length)
      ) {
        unknown.push({ ...candidate, reason: "帖子响应格式无效" });
        continue;
      }
      const evidence = languageEvidence(timeline);
      const item = { ...candidate, language_evidence: evidence };
      if (evidence.matched) matched.push(item);
      else if (evidence.uncertain)
        unknown.push({ ...item, reason: "帖子不足、语言未识别或存在部分错误" });
    } catch (error) {
      const info = errorInfo(error);
      unknown.push({ ...candidate, reason: info.message, status: info.status });
      if (info.status === 429) rateLimited = true;
    }
  }

  const common = {
    search_summary: searchSummary,
    search_requests: searchRequests,
    timeline_requests: timelineRequests,
    scanned_unique: all.length,
    location_matched: locationMatches.length,
    search_truncated: searchSummary.some((item) => item.truncated),
    undetermined: unknown,
    rate_limited: rateLimited,
  };

  if (matched.length)
    return { ...common, status: "matched", level: 1, data: matched };
  if (unknown.length)
    return {
      ...common,
      status: "undetermined",
      reason: "存在无法判断的账号，未执行降级",
      data: [],
    };
  if (locationMatches.length)
    return { ...common, status: "matched", level: 2, data: locationMatches };
  if (all.length) return { ...common, status: "matched", level: 3, data: all };
  return { ...common, status: "empty", level: null, data: [] };
}
