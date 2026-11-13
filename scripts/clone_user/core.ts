/** Standalone X profile-copy helpers; no dependency on the account or loop services. */
export function parseHandle(value: string): string {
  const handle = value.trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new Error('用户名必须是 1–15 位英文字母、数字或下划线');
  return handle;
}

/** Restrict downloads to X's image CDN and ask for the original-sized avatar. */
export function originalAvatarUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'pbs.twimg.com' || !url.pathname.startsWith('/profile_images/')) {
    throw new Error('头像地址不是预期的 X 图片地址');
  }
  // 资料页现在常给 _200x200 这类尺寸后缀；不剥掉就会把缩略图当成原图上传。
  url.pathname = url.pathname.replace(/_(normal|bigger|mini|reasonably_small|\d+x\d+)(?=\.[^./]+$)/, '');
  return url.toString();
}
