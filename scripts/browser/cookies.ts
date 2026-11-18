import '../../src/runtime-config.ts';
/** 读取并规范化从浏览器导出的 X 登录 cookie，供 Playwright 注入。 */
import { readFile, stat, access } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Playwright addCookies 所需的 cookie 结构；expires 为秒级时间戳。 */
export type XCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
};

export type CookieJar = { cookies: XCookie[]; warnings: string[] };

const X_DOMAIN = /^(?:\.)?(?:x|twitter)\.com$/i;
const REQUIRED = ['auth_token', 'ct0'] as const;
/** 未提供过期时间时按一年写入，避免只作为会话 cookie 而不落盘。 */
const DEFAULT_TTL_SECONDS = 365 * 24 * 60 * 60;
const SIMPLE_NAMES = ['auth_token', 'ct0', 'twid', 'guest_id', 'kdt', 'personalization_id'];

/** 账号默认 cookie 文件位置：.data/cookies/<账号数字ID>.json。 */
export function defaultCookiePath(accountId: string): string {
  return resolve('.data', 'cookies', `${accountId}.json`);
}

/** 允许用 X_COOKIE_FILE 覆盖默认路径。 */
export function cookieFileFor(accountId: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.X_COOKIE_FILE ? resolve(env.X_COOKIE_FILE) : defaultCookiePath(accountId);
}

/** 默认依次查找 .data/cookies/<账号ID>.json 和 .txt；X_COOKIE_FILE 存在时只查该路径。 */
export function cookieFileCandidates(accountId: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.X_COOKIE_FILE) return [cookieFileFor(accountId, env)];
  return [defaultCookiePath(accountId), resolve('.data', 'cookies', `${accountId}.txt`)];
}

/** 显式指定的文件必须可读；默认文件不存在时才允许复用浏览器登录态。 */
export async function findCookieFile(accountId: string | undefined, explicit?: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const configured = explicit || env.X_COOKIE_FILE;
  if (configured) {
    const path = resolve(configured);
    await access(path);
    return path;
  }
  if (!accountId) return undefined;
  for (const path of cookieFileCandidates(accountId, env)) {
    try { await access(path); return path; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return undefined;
}

/** 从三种常见导出格式中取出原始条目：数组、{ cookies } 或 { auth_token, ct0 }。 */
function rawEntries(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    if (Array.isArray(record.cookies)) return record.cookies;
    const simple = SIMPLE_NAMES.filter(name => typeof record[name] === 'string');
    if (simple.length) return simple.map(name => ({ name, value: record[name] }));
  }
  throw new Error('cookie 文件格式无效：需要数组、{ "cookies": [...] } 或 { "auth_token": "...", "ct0": "..." }');
}

function normalizeSameSite(value: unknown): 'Strict' | 'Lax' | 'None' {
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  if (text === 'strict') return 'Strict';
  if (text === 'none' || text === 'no_restriction') return 'None';
  return 'Lax';
}

/** 规范化 cookie 条目；只保留 x.com / twitter.com 的 cookie，并校验关键字段。 */
export function normalizeCookieJar(input: unknown, now = Date.now()): XCookie[] {
  const entries = rawEntries(input);
  const cookies = new Map<string, XCookie>();
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== 'object') throw new Error(`第 ${index + 1} 个 cookie 不是对象`);
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const value = typeof record.value === 'string' ? record.value.trim() : '';
    if (!name || !value) continue;
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`第 ${index + 1} 个 cookie 名称无效`);
    if (/[\s;]/.test(value)) throw new Error(`cookie ${name} 的值含空白或分号，可能复制时被截断`);
    const domain = (typeof record.domain === 'string' && record.domain.trim() ? record.domain.trim().toLowerCase() : '.x.com');
    if (!X_DOMAIN.test(domain)) continue;
    const path = typeof record.path === 'string' && record.path.startsWith('/') ? record.path : '/';
    // Playwright 用 expires，Chrome 导出扩展常用 expirationDate，两者都接受。
    const rawExpires = record.expires ?? record.expirationDate;
    const expires = typeof rawExpires === 'number' && Number.isFinite(rawExpires) && rawExpires > 0
      ? Math.floor(rawExpires)
      : Math.floor(now / 1000) + DEFAULT_TTL_SECONDS;
    const sameSite = normalizeSameSite(record.sameSite);
    cookies.set(`${name}\u0000${domain}`, {
      name, value, domain, path, expires, sameSite,
      // auth_token 是 HttpOnly 的会话凭证；其余属性缺省时按 X 的常见设置补齐。
      httpOnly: record.httpOnly === true || name === 'auth_token',
      secure: sameSite === 'None' || record.secure !== false,
    });
  }
  const present = new Set([...cookies.values()].map(cookie => cookie.name));
  const missing = REQUIRED.filter(name => !present.has(name));
  if (missing.length) throw new Error(`cookie 文件缺少 ${missing.join('、')}；请从已登录 x.com 的浏览器重新导出`);
  // 关键 cookie 排前面，便于日志和排查。
  const required = new Set<string>(REQUIRED);
  return [...cookies.values()].sort((a, b) => Number(required.has(b.name)) - Number(required.has(a.name)));
}

/** 解析 Get cookies.txt 一类扩展导出的 Netscape 格式；值为制表符分隔的 7 列。 */
export function parseNetscapeCookies(text: string): unknown[] {
  const entries: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const httpOnly = trimmed.startsWith('#HttpOnly_');
    if (trimmed.startsWith('#') && !httpOnly) continue;
    const columns = (httpOnly ? trimmed.slice('#HttpOnly_'.length) : trimmed).split('\t');
    if (columns.length !== 7) throw new Error('Netscape cookie 行格式无效，需要 7 个制表符分隔的字段');
    const [domain, , path, secure, expires, name, value] = columns;
    entries.push({
      name, value, domain, path, httpOnly,
      secure: secure.toUpperCase() === 'TRUE',
      expires: Number(expires) || undefined,
    });
  }
  return entries;
}

/** 解析复制来的 Cookie 请求头，如 `auth_token=...; ct0=...`。 */
export function parseCookieHeader(text: string): unknown[] {
  const entries: unknown[] = [];
  for (const part of text.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name && value) entries.push({ name, value, domain: '.x.com' });
  }
  return entries;
}

/** 读取 cookie 文件；自动识别 JSON、Netscape 文本与 Cookie 请求头，并返回权限提示。 */
export async function loadCookieJar(path: string): Promise<CookieJar> {
  const text = await readFile(path, 'utf8');
  let parsed: unknown;
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { parsed = JSON.parse(text); }
    catch { throw new Error(`cookie 文件不是有效 JSON：${path}`); }
  } else if (trimmed.startsWith('#') || trimmed.includes('\t')) {
    parsed = parseNetscapeCookies(text);
    if (!(parsed as unknown[]).length) throw new Error(`cookie 文件没有可用的 cookie：${path}`);
  } else {
    parsed = parseCookieHeader(text);
    if (!(parsed as unknown[]).length) throw new Error(`cookie 文件没有可用的 cookie：${path}`);
  }
  const cookies = normalizeCookieJar(parsed);
  const warnings: string[] = [];
  const mode = (await stat(path)).mode & 0o777;
  if (mode & 0o077) warnings.push(`cookie 文件权限过宽（0${mode.toString(8)}），建议执行 chmod 600 ${path}`);
  return { cookies, warnings };
}
