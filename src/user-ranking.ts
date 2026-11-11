/** 根据公开资料线索对用户进行稳定排序。 */
const saudiLocations = [
  "saudi", "ksa", "السعودية", "المملكة العربية السعودية", "沙特",
  "riyadh", "الرياض", "jeddah", "جدة", "dammam", "الدمام",
  "makkah", "mecca", "مكة", "madinah", "medina", "المدينة",
  "khobar", "الخبر", "taif", "الطائف", "tabuk", "تبوك",
  "abha", "أبها", "ابها", "buraidah", "بريدة", "hail", "حائل",
  "jazan", "جازان", "najran", "نجران", "jubail", "الجبيل",
];

type RankingUser = {
  location?: unknown;
  description?: unknown;
  public_metrics?: unknown;
};

/** 从未知输入中提取可用于排序的用户字段。 */
function rankingUser(value: unknown): RankingUser {
  return value !== null && typeof value === "object" ? value : {};
}

/** 判断自填地区是否包含已配置的沙特地区名称。 */
function hasSaudiLocation(location: unknown): boolean {
  if (typeof location !== "string") return false;
  const text = location.toLowerCase();
  return saudiLocations.some((term) =>
    /^[a-z]+$/.test(term)
      ? new RegExp(`(?:^|[^a-z])${term}(?:$|[^a-z])`, "i").test(text)
      : text.includes(term),
  );
}

/** 读取有效的粉丝数，缺失时使用默认排序值。 */
function followers(user: RankingUser): number {
  const metrics = user.public_metrics;
  const count = metrics !== null && typeof metrics === "object" && "followers_count" in metrics
    ? metrics.followers_count
    : undefined;
  return typeof count === "number" && Number.isFinite(count) && count >= 0
    ? count
    : -1;
}

/** 判断用户资料文本是否包含阿拉伯文字。 */
function hasArabicScript(user: RankingUser): boolean {
  return typeof user.description === "string" && /\p{Script=Arabic}/u.test(user.description);
}

/** Sort a copy, preserving the original order when all ranking criteria tie. */
/** 按地区、文字和粉丝数对候选进行稳定排序。 */
export function rankUsers<T>(items: T[], userOf: (item: T) => unknown): T[] {
  return [...items].sort((left, right) => {
    const a = rankingUser(userOf(left)), b = rankingUser(userOf(right));
    return Number(hasSaudiLocation(b.location)) - Number(hasSaudiLocation(a.location)) ||
      Number(hasArabicScript(b)) - Number(hasArabicScript(a)) ||
      followers(b) - followers(a);
  });
}
