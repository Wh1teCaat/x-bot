/** 批量导入 cookie：解析页面提交的条目并写入每个账号的 cookie 文件。 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeCookieJar, parseCookieHeader, parseNetscapeCookies, type XCookie } from './cookies.ts';

export type CookieImportEntry = {
  accountId?: string;
  username?: string;
  cookie: unknown;
};

/** 从 cookie 的 twid（u%3D<id> 或 u=<id>）中提取 X 账号数字 ID。 */
export function accountIdFromCookie(cookie: unknown): string | undefined {
  const entries = Array.isArray(cookie)
    ? cookie
    : cookie && typeof cookie === 'object'
      ? (Array.isArray((cookie as { cookies?: unknown }).cookies) ? (cookie as { cookies: unknown[] }).cookies : [cookie])
      : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (record.name !== 'twid' || typeof record.value !== 'string') continue;
    let value = record.value;
    try { value = decodeURIComponent(value); } catch {}
    const match = value.match(/(?:^|[;&])u=(\d{1,19})/);
    if (match) return match[1];
  }
  return undefined;
}

/** 判断一个数组是否是浏览器扩展直接导出的 cookie 条目数组。 */
function isBareCookieArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry) =>
    Boolean(entry) && typeof entry === 'object' &&
    typeof (entry as Record<string, unknown>).name === 'string' &&
    typeof (entry as Record<string, unknown>).value === 'string',
  );
}

/** 解析单个 cookie 值：对象、JSON 文本、Netscape cookies.txt 或 Cookie 请求头。 */
export function parseCookieValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) throw new Error('cookie 为空');
  if (text.startsWith('{') || text.startsWith('[')) {
    try { return JSON.parse(text); } catch { throw new Error('cookie JSON 无效'); }
  }
  if (text.startsWith('#') || text.includes('\t')) return parseNetscapeCookies(text);
  return parseCookieHeader(text);
}

/** 解析批量导入请求；接受数组或 { accounts: [...] }。 */
/** 解析批量导入请求；直接接受扩展导出的单个 cookie 数组，或 { accountId, cookie } 包装。 */
export function parseCookieImportPayload(payload: unknown): CookieImportEntry[] {
  // 用户直接粘贴 Chrome 扩展导出的 cookie 数组：从 twid 识别账号。
  if (isBareCookieArray(payload)) {
    const accountId = accountIdFromCookie(payload);
    if (!accountId) throw new Error('无法从 cookie 的 twid 识别账号 ID；请改用 [{ "accountId": "...", "cookie": [...] }] 格式');
    return [{ accountId, cookie: payload }];
  }
  // 单个 { cookies: [...] } / { auth_token, ct0, twid } 也按一个账号处理。
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && !Array.isArray((payload as { accounts?: unknown }).accounts) && !('cookie' in payload)) {
    const accountId = accountIdFromCookie(payload);
    if (!accountId) throw new Error('无法从 cookie 的 twid 识别账号 ID；请改用 { "accountId": "...", "cookie": {...} } 格式');
    return [{ accountId, cookie: payload }];
  }
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { accounts?: unknown }).accounts)
      ? (payload as { accounts: unknown[] }).accounts
      : null;
  if (!list) throw new Error('请求格式无效：需要 cookie 数组、{ "accounts": [...] } 或 { accountId, cookie }');
  if (!list.length) throw new Error('没有可导入的账号');
  if (list.length > 500) throw new Error('一次最多导入 500 个账号');
  return list.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`第 ${index + 1} 项不是对象`);
    const record = entry as Record<string, unknown>;
    if (!('cookie' in record)) throw new Error(`第 ${index + 1} 项缺少 cookie`);
    let accountId = typeof record.accountId === 'string' ? record.accountId.trim() : undefined;
    const username = typeof record.username === 'string' ? record.username.trim().replace(/^@/, '') : undefined;
    if (accountId && !/^\d{1,19}$/.test(accountId)) throw new Error(`第 ${index + 1} 项 accountId 无效`);
    if (username && !/^[A-Za-z0-9_]{1,15}$/.test(username)) throw new Error(`第 ${index + 1} 项 username 无效`);
    if (!accountId && !username) accountId = accountIdFromCookie(record.cookie);
    if (!accountId && !username) throw new Error(`第 ${index + 1} 项需要 accountId、username，或 cookie 中包含 twid`);
    return { accountId, username, cookie: record.cookie };
  });
}

/** 将规范化后的 cookie 写入 .data/cookies/<账号ID>.json，权限 0600。 */
export function writeCookieFile(dataDir: string, accountId: string, cookie: unknown): { path: string; count: number; cookies: XCookie[] } {
  if (!/^\d{1,19}$/.test(accountId)) throw new Error('账号 ID 无效');
  const cookies = normalizeCookieJar(parseCookieValue(cookie));
  const dir = join(dataDir, 'cookies');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${accountId}.json`);
  writeFileSync(path, JSON.stringify({ cookies }, null, 2), { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
  return { path, count: cookies.length, cookies };
}
