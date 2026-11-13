/** 解析回复 CSV，按用户去重并进行文字初筛。 */
// Parse RFC 4180-style CSV, including quoted commas, CRLF and embedded newlines.
/** 解析支持转义引号、换行和 BOM 的 CSV。 */
export function parseCsv(input) {
  const rows = []; let row = []; let field = ''; let quoted = false; let closed = false;
  input = input.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else field += ch;
    } else if (ch === '"') {
      if (field || closed) throw new Error('CSV 引号位置无效');
      quoted = true;
    } else if (ch === ',' || ch === '\n' || ch === '\r') {
      row.push(field); field = ''; closed = false;
      if (ch !== ',') {
        rows.push(row); row = [];
        if (ch === '\r' && input[i + 1] === '\n') i++;
      }
    } else {
      if (closed) throw new Error('CSV 引号后的内容无效');
      field += ch;
    }
  }
  if (quoted) throw new Error('CSV 引号未闭合');
  if (field || row.length || closed) { row.push(field); rows.push(row); }
  return rows;
}

/** 从有效的公开主页链接中提取并按用户名合并候选。 */
export function collectCandidates(csv) {
  const rows = parseCsv(csv);
  if (!rows.length) throw new Error('CSV 为空');
  const header = rows[0];
  const textIndex = header.indexOf('text');
  const urlIndex = header.indexOf('profileUrl');
  if (textIndex < 0 || urlIndex < 0) throw new Error('CSV 缺少 text 或 profileUrl 列');
  const users = new Map();
  for (const row of rows.slice(1)) {
    if (row.length !== header.length) throw new Error('CSV 行列数不匹配');
    let url;
    try { url = new URL(row[urlIndex]); } catch { continue; }
    if (!['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'].includes(url.hostname.toLowerCase()) || url.protocol !== 'https:') continue;
    const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (!users.has(key)) users.set(key, { username: match[1], profileUrl: `https://x.com/${match[1]}`, replies: [] });
    users.get(key).replies.push(row[textIndex]);
  }
  return [...users.values()];
}

// Script-based optional language filter; profile location is not used.
/** 归一化表头，忽略大小写、空格、下划线和连字符。 */
function normalizeHeader(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[\s_\-()（）]/g, '');
}

/** 在表头中定位用户数字 ID 列；评论自身的 id 列不参与匹配。 */
function userIdColumn(header) {
  const keys = header.map(normalizeHeader);
  const exact = ['userid', 'authorid', 'fromid', 'accountid'];
  const found = keys.findIndex(key => exact.includes(key) || key.endsWith('userid') || key.endsWith('authorid'));
  return found;
}

/** 在表头中定位关注数/粉丝数列；优先精确匹配，再按关键词兜底。 */
function countColumn(header, kind) {
  const keys = header.map(normalizeHeader);
  const exact = kind === 'followers'
    ? ['followers', 'followerscount', 'followercount', 'follower', 'fans', 'fanscount', 'followersnum', 'numfollowers', '粉丝', '粉丝数', '粉丝数量', '被关注', '被关注数']
    : ['following', 'followingcount', 'followcount', 'follow', 'follows', 'followings', 'followingnum', 'numfollowing', 'friends', 'friendscount', 'numfriends', '关注', '关注数', '关注数量'];
  const found = keys.findIndex(key => exact.includes(key));
  if (found >= 0) return found;
  return keys.findIndex(key => kind === 'followers'
    ? key.includes('follower') || key.includes('粉丝') || key.includes('被关注')
    : key.includes('following') || key.includes('关注'));
}

/** 解析 CommentCrate CSV 中的计数，支持 1,234、1.2K、3M、2万 等写法。 */
export function parseCountValue(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value);
  if (typeof value !== 'string') return undefined;
  let text = value.normalize('NFKC').trim();
  if (!text) return undefined;
  text = text
    .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/\s+/g, '');
  const match = text.match(/^([\d.,]+)([KMB万千]?)$/i);
  if (!match) return undefined;
  const unit = match[2].toLocaleLowerCase();
  const raw = match[1];
  const numeric = parseFloat(unit ? raw.replace(/,/g, '.') : raw.replace(/[.,]/g, ''));
  if (!Number.isFinite(numeric) || numeric < 0) return undefined;
  const factor = { k: 1e3, m: 1e6, b: 1e9, '万': 1e4, '千': 1e3 }[unit] || 1;
  return Math.round(numeric * factor);
}

/** 核对原帖与回复 ID，将阿拉伯文字用户和其余用户分组，并带上 CSV 里的关注/粉丝数。 */
export function partitionReplyCandidates(csv, expectedPostId) {
  const rows = parseCsv(csv);
  const header = rows.shift();
  if (!header) throw new Error('CSV 为空');
  const cols = ['id', 'text', 'profileUrl', 'postUrl'].map(name => header.indexOf(name));
  if (cols.some(i => i < 0)) throw new Error('CSV 缺少回复 ID、文字、主页或原帖链接');
  const [idIndex, textIndex, profileIndex, postIndex] = cols;
  const followersIndex = countColumn(header, 'followers');
  const followingIndex = countColumn(header, 'following');
  const userIdIndex = userIdColumn(header);
  const users = new Map();
  for (const row of rows) {
    if (row.length !== header.length) throw new Error('CSV 行列数不匹配');
    const id = row[idIndex];
    if (!/^\d{1,19}$/.test(id)) continue;
    let profile, post;
    try { profile = new URL(row[profileIndex]); post = new URL(row[postIndex]); } catch { continue; }
    const trustedHost = u => u.protocol === 'https:' && ['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'].includes(u.hostname.toLowerCase());
    const user = profile.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
    const postMatch = post.pathname.match(/^\/[A-Za-z0-9_]{1,15}\/status\/(\d{1,19})\/?$/);
    if (!trustedHost(profile) || !trustedHost(post) || !user || !postMatch || postMatch[1] !== expectedPostId || id === expectedPostId) continue;
    const text = row[textIndex];
    const followers = followersIndex >= 0 ? parseCountValue(row[followersIndex]) : undefined;
    const following = followingIndex >= 0 ? parseCountValue(row[followingIndex]) : undefined;
    const userId = userIdIndex >= 0 && /^\d{1,19}$/.test(row[userIdIndex]) ? row[userIdIndex] : undefined;
    const key = user[1].toLowerCase();
    if (!users.has(key)) users.set(key, { username: user[1], profileUrl: `https://x.com/${user[1]}`, replies: [], replyIds: [], followers, following, userId });
    const candidate = users.get(key);
    if (candidate.followers === undefined && followers !== undefined) candidate.followers = followers;
    if (candidate.following === undefined && following !== undefined) candidate.following = following;
    if (candidate.userId === undefined && userId !== undefined) candidate.userId = userId;
    if (!candidate.replyIds.includes(id)) { candidate.replyIds.push(id); candidate.replies.push(text); }
  }
  const direct = [], remaining = [];
  for (const candidate of users.values()) {
    const matched = candidate.replies.some(text => [...text].filter(ch => /\p{Script=Arabic}/u.test(ch) && /\p{Letter}/u.test(ch)).length >= 2);
    (matched ? direct : remaining).push(candidate);
  }
  return { direct, remaining, hasFollowerCounts: followersIndex >= 0 && followingIndex >= 0, hasUserIds: userIdIndex >= 0, header };
}

/** 返回具有阿拉伯文字回复及对应回复 ID 的候选用户。 */
export function collectArabicReplyCandidates(csv, expectedPostId) {
  const { direct } = partitionReplyCandidates(csv, expectedPostId);
  return direct.map(c => {
    const indices = c.replies.map((text, i) => [...text].filter(ch => /\p{Script=Arabic}/u.test(ch) && /\p{Letter}/u.test(ch)).length >= 2 ? i : -1).filter(i => i >= 0);
    return { ...c, replies: indices.map(i => c.replies[i]), replyIds: indices.map(i => c.replyIds[i]) };
  });
}

/** 将二维数组序列化为带 BOM 的 RFC 4180 CSV。 */
export function toCsv(rows) {
  const cell = value => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** 把关注/粉丝数写回 CSV；已有同名列时覆盖，没有时追加到末尾。 */
export function enrichCsv(csv, counts) {
  const rows = parseCsv(csv);
  if (!rows.length) throw new Error('CSV 为空');
  const header = rows[0];
  const originalWidth = header.length;
  const profileIndex = header.indexOf('profileUrl');
  if (profileIndex < 0) throw new Error('CSV 缺少 profileUrl 列');
  let followersIndex = countColumn(header, 'followers');
  let followingIndex = countColumn(header, 'following');
  if (followersIndex < 0) { header.push('followersCount'); followersIndex = header.length - 1; }
  if (followingIndex < 0) { header.push('followingCount'); followingIndex = header.length - 1; }
  for (const row of rows.slice(1)) {
    if (row.length !== originalWidth) throw new Error('CSV 行列数不匹配');
    while (row.length < header.length) row.push('');
    let username;
    try { username = new URL(row[profileIndex]).pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/)?.[1]; } catch { username = undefined; }
    const values = username ? counts[username.toLowerCase()] : undefined;
    row[followersIndex] = values?.followers ?? row[followersIndex] ?? '';
    row[followingIndex] = values?.following ?? row[followingIndex] ?? '';
  }
  return toCsv(rows);
}
