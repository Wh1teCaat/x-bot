/** 按推文 ID 从新到旧排序；X 主页可能把置顶帖放在最前。 */
export function sortPostsNewestFirst<T extends { url: string }>(posts: T[]): T[] {
  const idOf = (post: T) => {
    try { return new URL(post.url).pathname.split('/').pop() ?? '0'; } catch { return '0'; }
  };
  return [...posts].sort((a, b) => {
    const left = idOf(a), right = idOf(b);
    return left.length - right.length || right.localeCompare(left);
  });
}
