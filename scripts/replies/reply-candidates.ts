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

// Script-based initial filter, not a language or nationality classifier.
/** 核对原帖与回复 ID，再将阿拉伯文字用户和其余用户分组。 */
export function partitionReplyCandidates(csv, expectedPostId) {
  const rows = parseCsv(csv);
  const header = rows.shift();
  if (!header) throw new Error('CSV 为空');
  const cols = ['id', 'text', 'profileUrl', 'postUrl'].map(name => header.indexOf(name));
  if (cols.some(i => i < 0)) throw new Error('CSV 缺少回复 ID、文字、主页或原帖链接');
  const [idIndex, textIndex, profileIndex, postIndex] = cols;
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
    const key = user[1].toLowerCase();
    if (!users.has(key)) users.set(key, { username: user[1], profileUrl: `https://x.com/${user[1]}`, replies: [], replyIds: [] });
    const candidate = users.get(key);
    if (!candidate.replyIds.includes(id)) { candidate.replyIds.push(id); candidate.replies.push(text); }
  }
  const direct = [], remaining = [];
  for (const candidate of users.values()) {
    const matched = candidate.replies.some(text => [...text].filter(ch => /\p{Script=Arabic}/u.test(ch) && /\p{Letter}/u.test(ch)).length >= 2);
    (matched ? direct : remaining).push(candidate);
  }
  return { direct, remaining };
}

/** 返回具有阿拉伯文字回复及对应回复 ID 的候选用户。 */
export function collectArabicReplyCandidates(csv, expectedPostId) {
  const { direct } = partitionReplyCandidates(csv, expectedPostId);
  return direct.map(c => {
    const indices = c.replies.map((text, i) => [...text].filter(ch => /\p{Script=Arabic}/u.test(ch) && /\p{Letter}/u.test(ch)).length >= 2 ? i : -1).filter(i => i >= 0);
    return { ...c, replies: indices.map(i => c.replies[i]), replyIds: indices.map(i => c.replyIds[i]) };
  });
}

// Only the profile location field is evidence; a post mentioning Saudi Arabia
// does not establish where its author lives.
/** 判断自填地区文本是否包含已配置的沙特地区关键词。 */
export function hasSaudiLocation(location) {
  if (typeof location !== 'string' || !location.trim()) return false;
  const text = location.normalize('NFKC').toLocaleLowerCase();
  return /(?:^|[^\p{L}\p{N}])(?:saudi arabia|kingdom of saudi arabia|ksa|riyadh|jeddah|makkah|mecca|medina|madinah|dammam|khobar)(?=$|[^\p{L}\p{N}])/u.test(text)
    || /السعودية|السعوديه|المملكة العربية السعودية|الرياض|جدة|جده|مكة|مكه|المدينة المنورة|الدمام|الخبر/u.test(text);
}

/** 按地区和回复关键词为候选排序，保留相同分数的原有顺序。 */
export function rankCandidates(candidates, keywords) {
  const terms = keywords.map(s => s.trim().normalize('NFKC').toLocaleLowerCase()).filter(Boolean);
  return candidates
    .filter(candidate => hasSaudiLocation(candidate.location))
    .map(candidate => ({
      ...candidate,
      matchedKeywords: terms.filter(term => candidate.replies.some(reply => reply.normalize('NFKC').toLocaleLowerCase().includes(term))),
    }))
    .sort((a, b) => Number(b.matchedKeywords.length > 0) - Number(a.matchedKeywords.length > 0));
}
