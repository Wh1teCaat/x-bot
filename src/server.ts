/** 提供本机 OAuth 授权与 X API 代理服务。 */
import "dotenv/config";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { discoverSaudiAccount } from "./saudi-discovery.ts";
import { rankUsers } from "./user-ranking.ts";
import { followFirstArabFollower } from "./arab-follow.ts";
import { FollowStore, syncFollowing } from "./follow-store.ts";
import { shouldAutoStartAccountSession, startAccountSession } from "./account-session-manager.ts";

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid PORT");

const origin = `http://127.0.0.1:${port}`;
const authorizationScope = "tweet.read users.read follows.read follows.write offline.access";
const redirectUri = process.env.X_REDIRECT_URI || `${origin}/oauth/callback`;
if (redirectUri !== `${origin}/oauth/callback`)
  throw new Error(`X_REDIRECT_URI must be ${origin}/oauth/callback`);

const clientId = process.env.X_CLIENT_ID;
const clientSecret = process.env.X_CLIENT_SECRET;
if (!clientId) throw new Error("Set X_CLIENT_ID in .env");

// The override is restricted to test processes; never point real credentials at a mock.
const apiBase =
  (process.env.NODE_ENV === "test" && process.env.X_TEST_API_BASE) ||
  "https://api.x.com";
const authBase =
  (process.env.NODE_ENV === "test" && process.env.X_TEST_AUTH_BASE) ||
  "https://x.com";
const dataDir =
  (process.env.NODE_ENV === "test" && process.env.X_TEST_DATA_DIR) || ".data";

mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const keyPath = join(dataDir, "key");

if (!existsSync(keyPath)) {
  try {
    writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

const key = readFileSync(keyPath);
if (key.length !== 32) throw new Error("Invalid encryption key");
const storePath = join(dataDir, "accounts.enc");

type User = { id: string; name: string; username: string };

type Token = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
};

type Account = {
  user: User;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
};

/** 解密并读取本地保存的授权账号。 */
function readAccounts(): Record<string, Account> {
  if (!existsSync(storePath)) return {};

  const blob = readFileSync(storePath);
  const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(12, 28));

  return JSON.parse(
    Buffer.concat([
      decipher.update(blob.subarray(28)),
      decipher.final(),
    ]).toString(),
  );
}

/** 加密保存账号令牌，并通过原子替换避免部分写入。 */
function saveAccount(account: Account) {
  const accounts = readAccounts();
  accounts[account.user.id] = account;

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(accounts)),
    cipher.final(),
  ]);
  const temp = `${storePath}.${randomBytes(8).toString("hex")}.tmp`;

  writeFileSync(temp, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temp, storePath);
  chmodSync(storePath, 0o600);
}

class HttpError extends Error {
  status: number;
  headers: Record<string, string>;

  /** 携带响应状态和可安全转发的限流头。 */
  constructor(
    status: number,
    message: string,
    headers: Record<string, string> = {},
  ) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const pending = new Map<string, { verifier: string; expires: number }>();
const refreshing = new Map<string, Promise<Account>>();

/** 为本机页面设置缓存、内容安全策略和基础响应头。 */
function headers(res: ServerResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self' https://x.com; base-uri 'none'; frame-ancestors 'none'",
  );
}

/** 返回 JSON 格式的本地接口响应。 */
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

/** 从请求头中提取指定的 OAuth 状态 Cookie。 */
function cookie(req: IncomingMessage, name: string) {
  return (req.headers.cookie || "")
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

/** 调用 X API，限制超时并转换可安全暴露的错误。 */
async function xRequest(path: string, init: RequestInit = {}) {
  let response: Response;

  try {
    response = await fetch(`${apiBase}${path}`, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new HttpError(502, "无法连接 X API，请检查网络后重试。");
  }
  const payload: any = await response.json().catch(() => ({}));

  if (!response.ok) {
    const forwarded: Record<string, string> = {};

    for (const name of [
      "retry-after",
      "x-rate-limit-limit",
      "x-rate-limit-remaining",
      "x-rate-limit-reset",
    ]) {
      const value = response.headers.get(name);
      if (value) forwarded[name] = value;
    }

    // Do not return token endpoint response bodies: they can contain sensitive values.
    const message = path.startsWith("/2/oauth2/")
      ? `X OAuth 请求失败（${response.status}），请检查应用配置或重新授权。`
      : `X API 请求失败（${response.status}）：${String(payload.detail || payload.title || "请检查权限、额度和请求参数").slice(0, 500)}`;
    throw new HttpError(
      response.status === 429
        ? 429
        : response.status >= 500
          ? 502
          : response.status,
      message,
      forwarded,
    );
  }

  return payload;
}

/** 根据应用类型请求 OAuth 令牌并校验结果。 */
async function tokenRequest(params: URLSearchParams): Promise<Token> {
  const requestHeaders: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };

  if (clientSecret)
    requestHeaders.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(clientId!)}:${encodeURIComponent(clientSecret)}`).toString("base64")}`;
  else params.set("client_id", clientId!);

  const result = await xRequest("/2/oauth2/token", {
    method: "POST",
    headers: requestHeaders,
    body: params,
  });

  if (
    typeof result.access_token !== "string" ||
    !Number.isFinite(result.expires_in) ||
    result.expires_in <= 0
  )
    throw new HttpError(502, "X 返回了无效的令牌响应。");

  return result;
}

/** 使用用户令牌读取并校验当前授权账号。 */
async function getMe(token: string): Promise<User> {
  const result = await xRequest("/2/users/me", {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (
    !result.data ||
    !/^\d+$/.test(result.data.id) ||
    typeof result.data.username !== "string"
  )
    throw new HttpError(502, "X 返回了无效的用户信息。");

  return result.data;
}

/** 将用户资料与令牌响应整理为可保存的账号记录。 */
function fromToken(user: User, token: Token, previous?: Account): Account {
  return {
    user,
    accessToken: token.access_token,
    refreshToken: token.refresh_token || previous?.refreshToken,
    expiresAt: Date.now() + token.expires_in * 1000,
    scope: token.scope || previous?.scope,
  };
}

/** 获取有效令牌，必要时合并并发刷新请求。 */
async function usableAccount(id: string): Promise<Account> {
  const current = readAccounts()[id];

  if (!current) throw new HttpError(404, "未找到授权账号。");
  if (current.expiresAt > Date.now() + 60_000) return current;
  if (!current.refreshToken)
    throw new HttpError(401, "令牌已过期，请重新授权该账号。");

  let ongoing = refreshing.get(id);
  if (!ongoing) {
    ongoing = (async () => {
      const token = await tokenRequest(
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: current.refreshToken!,
        }),
      );
      const updated = fromToken(current.user, token, current);
      saveAccount(updated);
      return updated;
    })();

    refreshing.set(id, ongoing);
    ongoing.finally(() => refreshing.delete(id)).catch(() => {});
  }

  return ongoing;
}

const page = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const followStore = new FollowStore(join(dataDir, "following.sqlite"));
const runningFollow = new Set<string>();

/** 预留目标状态并发起 API 关注，保留不确定结果以防重复。 */
async function sendFollow(accountId: string, targetId: string, accessToken: string) {
  const previous = followStore.status(accountId, targetId);
  if (previous === "following" || previous === "pending") return { data: { following: previous === "following", pending_follow: previous === "pending" }, cached: true };
  if (!followStore.reserve(accountId, targetId)) throw new HttpError(409, "关注结果不明确或正在处理中，请先核实。");
  let result;
  try { result = await xRequest(`/2/users/${accountId}/following`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ target_user_id: targetId }),
  }); } catch (error) {
    // A 429 response explicitly rejects this request; ambiguous transport and
    // server errors keep the reservation to prevent a duplicate follow.
    if (error instanceof HttpError && error.status === 429) followStore.clearUncertain(accountId, targetId);
    throw error;
  }
  if (!result.errors?.length && result.data?.pending_follow === true)
    followStore.record(accountId, targetId, "pending");
  else if (!result.errors?.length && result.data?.following === true)
    followStore.record(accountId, targetId, "following");
  return result;
}

const server = createServer(async (req, res) => {
  headers(res);

  try {
    if (req.headers.host !== `127.0.0.1:${port}`)
      throw new HttpError(403, "Invalid host");

    const url = new URL(req.url || "/", origin);

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page);
      return;
    }

    if (req.method === "POST" && url.pathname === "/oauth/start") {
      if (req.headers.origin !== origin)
        throw new HttpError(403, "Invalid origin");

      for (const [state, item] of pending)
        if (item.expires < Date.now()) pending.delete(state);
      if (pending.size >= 100)
        throw new HttpError(429, "待完成的授权过多，请稍后重试。");

      const state = randomBytes(32).toString("base64url");
      const verifier = randomBytes(48).toString("base64url");
      pending.set(state, { verifier, expires: Date.now() + 10 * 60_000 });
      const challenge = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      const query = new URLSearchParams({
        response_type: "code",
        client_id: clientId!,
        redirect_uri: redirectUri,
        scope: authorizationScope,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });

      res.setHeader(
        "Set-Cookie",
        `oauth_${state}=${state}; HttpOnly; SameSite=Lax; Path=/oauth/callback; Max-Age=600`,
      );
      res.writeHead(303, {
        Location: `${authBase}/i/oauth2/authorize?${query}`,
      });
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/oauth/callback") {
      const state = url.searchParams.get("state") || "";
      if (!/^[A-Za-z0-9_-]{43}$/.test(state))
        throw new HttpError(400, "无效的授权状态。");

      const attempt = pending.get(state);
      pending.delete(state);

      res.setHeader(
        "Set-Cookie",
        `oauth_${state}=; HttpOnly; SameSite=Lax; Path=/oauth/callback; Max-Age=0`,
      );
      if (
        !attempt ||
        attempt.expires < Date.now() ||
        cookie(req, `oauth_${state}`) !== state
      )
        throw new HttpError(400, "授权已过期或状态不匹配，请重新开始。");

      if (url.searchParams.has("error"))
        throw new HttpError(400, "X 授权未完成，请重新尝试。");
      const code = url.searchParams.get("code");
      if (!code) throw new HttpError(400, "缺少授权码。");

      const token = await tokenRequest(
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          code_verifier: attempt.verifier,
        }),
      );
      // OAuth permits omitting scope when it is identical to the requested scope.
      token.scope ??= authorizationScope;
      const user = await getMe(token.access_token);
      saveAccount(fromToken(user, token));

      // 测试环境只验证授权，不启动真实浏览器或关注任务。
      if (shouldAutoStartAccountSession(token.scope || "", { nodeEnv: process.env.NODE_ENV, setting: process.env.X_AUTO_START_LOOP })) {
        try { await startAccountSession(user); }
        catch (error) { console.error(`已授权但无法启动账号会话：${error instanceof Error ? error.message : String(error)}`); }
      }

      res.writeHead(303, { Location: "/" });
      res.end();
      return;
    }

    const autoFollowMatch = url.pathname.match(/^\/api\/accounts\/(\d{1,19})\/follow-arab-follower$/);
    if (req.method === "POST" && autoFollowMatch) {
      if (req.headers.origin !== origin || req.headers["x-local-request"] !== "1")
        throw new HttpError(403, "Invalid local request");
      const accountId = autoFollowMatch[1];
      if (runningFollow.has(accountId)) throw new HttpError(409, "该账号的关注任务正在运行。");
      runningFollow.add(accountId);
      try {
        const account = await usableAccount(accountId);
        if (!account.scope?.split(/\s+/).includes("follows.write"))
          throw new HttpError(403, "账号缺少关注权限，请重新授权并授予关注权限。");
        const authHeaders = { Authorization: `Bearer ${account.accessToken}` };
        let sync;
        try {
          sync = await syncFollowing(followStore, accountId, (token) => {
            const params = new URLSearchParams({ max_results: "1000" });
            if (token) params.set("pagination_token", token);
            return xRequest(`/2/users/${accountId}/following?${params}`, { headers: authHeaders });
          });
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(502, error instanceof Error ? error.message : "同步已关注列表失败。");
        }
        const params = new URLSearchParams({ query: "arab", max_results: "10", "user.fields": "description,location,public_metrics,verified" });
        const result = await followFirstArabFollower(accountId, {
          search: () => xRequest(`/2/users/search?${params}`, { headers: authHeaders }),
          followers: (id, nextToken) => {
            const followerParams = new URLSearchParams({ max_results: "1", "user.fields": "connection_status" });
            if (nextToken) followerParams.set("pagination_token", nextToken);
            return xRequest(`/2/users/${id}/followers?${followerParams}`, { headers: authHeaders });
          },
          knownStatus: (id) => followStore.status(accountId, id),
          follow: async (id) => {
            try {
              return await sendFollow(accountId, id, account.accessToken);
            } catch (error) {
              if (error instanceof HttpError)
                throw new HttpError(error.status, `关注粉丝 ${id} 时出错：${error.message}；重试前请先检查关注状态。`, error.headers);
              throw error;
            }
          },
        });
        json(res, 200, { ...result, following_sync: sync });
      } finally {
        runningFollow.delete(accountId);
      }
      return;
    }

    const followMatch = url.pathname.match(
      /^\/api\/accounts\/(\d{1,19})\/users\/(\d{1,19})\/follow$/,
    );
    if (req.method === "POST" && followMatch) {
      if (req.headers.origin !== origin || req.headers["x-local-request"] !== "1")
        throw new HttpError(403, "Invalid local request");
      const [, accountId, targetId] = followMatch;
      if (accountId === targetId) throw new HttpError(400, "不能关注自己的账号。");
      if (runningFollow.has(accountId)) throw new HttpError(409, "该账号的关注任务正在运行。");
      runningFollow.add(accountId);
      try {
        const account = await usableAccount(accountId);
        if (!account.scope?.split(/\s+/).includes("follows.write"))
          throw new HttpError(403, "账号缺少关注权限，请重新授权并授予关注权限。");
        const result = await sendFollow(accountId, targetId, account.accessToken);
        json(res, 200, result);
      } finally {
        runningFollow.delete(accountId);
      }
      return;
    }

    const discoveryMatch = url.pathname.match(
      /^\/api\/accounts\/(\d+)\/discover-saudi$/,
    );
    if (req.method === "POST" && discoveryMatch) {
      if (
        req.headers.origin !== origin ||
        req.headers["x-local-request"] !== "1"
      ) {
        throw new HttpError(403, "Invalid local request");
      }

      const account = await usableAccount(discoveryMatch[1]);
      const authHeaders = { Authorization: `Bearer ${account.accessToken}` };
      const result = await discoverSaudiAccount({
        search: (keyword, nextToken) => {
          const params = new URLSearchParams({
            query: keyword,
            max_results: "10",
            "user.fields": "description,location,public_metrics,verified",
          });
          if (nextToken) params.set("next_token", nextToken);
          return xRequest(`/2/users/search?${params}`, {
            headers: authHeaders,
          });
        },
        timeline: (id) => {
          const params = new URLSearchParams({
            max_results: "10",
            exclude: "retweets",
            "tweet.fields": "lang,referenced_tweets",
          });
          return xRequest(`/2/users/${id}/tweets?${params}`, {
            headers: authHeaders,
          });
        },
      });
      json(res, 200, {
        ...result,
        data: rankUsers(result.data, (item) => item.user),
        ...(Array.isArray(result.undetermined)
          ? { undetermined: rankUsers(result.undetermined, (item) => item.user) }
          : {}),
      });
      return;
    }

    if (req.method !== "GET" || !url.pathname.startsWith("/api/"))
      throw new HttpError(404, "Not found");
    if (req.headers["x-local-request"] !== "1")
      throw new HttpError(403, "Missing local request header");

    if (url.pathname === "/api/accounts") {
      json(res, 200, {
        accounts: Object.values(readAccounts()).map(
          ({ user, expiresAt, scope, refreshToken }) => ({
            user,
            expiresAt,
            scope,
            refreshable: Boolean(refreshToken),
          }),
        ),
      });
      return;
    }

    if (url.pathname === "/api/recommendations")
      throw new HttpError(501, "X 公开 API 未提供与页面“推荐关注”等价的接口。");

    const lookup = url.pathname.match(/^\/api\/accounts\/(\d{1,19})\/users\/by$/);
    if (lookup) {
      const names = (url.searchParams.get("usernames") || "").split(",");
      if (!names.length || names.length > 100 || names.some(name => !/^[A-Za-z0-9_]{1,15}$/.test(name)))
        throw new HttpError(400, "用户名必须为 1–100 个有效的 X 用户名。");
      const account = await usableAccount(lookup[1]);
      if (!account.scope?.split(/\s+/).includes("users.read")) throw new HttpError(403, "账号缺少用户读取权限，请重新授权。");
      const params = new URLSearchParams({ usernames: names.join(",") });
      const result = await xRequest(`/2/users/by?${params}`, { headers: { Authorization: `Bearer ${account.accessToken}` } });
      json(res, 200, result); return;
    }

    const match = url.pathname.match(
      /^\/api\/accounts\/(\d+)\/(me|search|users\/(\d+)\/followers)$/,
    );
    if (!match) throw new HttpError(404, "Not found");

    if (match[2] === "search") {
      const query = (url.searchParams.get("query") || "").trim();
      if (!/^[A-Za-z0-9_' ]{1,50}$/.test(query)) {
        throw new HttpError(
          400,
          "搜索词需为 1–50 个英文字母、数字、空格、下划线或单引号。",
        );
      }

      const location = (url.searchParams.get("location") || "").trim();
      if (location.length > 100) {
        throw new HttpError(400, "地区筛选文字不能超过 100 个字符。");
      }

      const language = url.searchParams.get("language") || "";
      if (language && language !== "ar") {
        throw new HttpError(400, "目前仅支持阿拉伯语筛选（ar）。");
      }
      const account = await usableAccount(match[1]);
      const params = new URLSearchParams({
        query,
        max_results: "10",
        "user.fields": "description,location,public_metrics,verified",
      });
      const nextToken = url.searchParams.get("next_token");
      if (nextToken) params.set("next_token", nextToken);

      const result = await xRequest(`/2/users/search?${params}`, {
        headers: { Authorization: `Bearer ${account.accessToken}` },
      });
      if (location || language) {
        const users = Array.isArray(result.data) ? result.data : [];
        const matchingUsers = location
          ? users.filter(
              (user: { location?: unknown }) =>
                typeof user.location === "string" &&
                user.location.toLowerCase().includes(location.toLowerCase()),
            )
          : users;

        if (language) {
          const matched: any[] = [];
          const unknown: any[] = [];
          let examined = 0;
          let stopReason = "";

          for (const user of matchingUsers) {
            if (stopReason) {
              unknown.push({ user, reason: stopReason });
              continue;
            }
            if (typeof user.id !== "string" || !/^\d{1,19}$/.test(user.id)) {
              unknown.push({ user, reason: "用户 ID 无效" });
              continue;
            }

            const postParams = new URLSearchParams({
              max_results: "10",
              exclude: "retweets",
              "tweet.fields": "lang,referenced_tweets",
            });
            try {
              const timeline = await xRequest(
                `/2/users/${user.id}/tweets?${postParams}`,
                {
                  headers: { Authorization: `Bearer ${account.accessToken}` },
                },
              );
              examined++;
              const posts = Array.isArray(timeline.data) ? timeline.data : [];
              const stats = {
                total: posts.length,
                arabic_posts: 0,
                arabic_replies: 0,
                other_language: 0,
                unknown_language: 0,
              };
              for (const post of posts) {
                if (post.lang === "ar") {
                  const references =
                    post.referenced_tweets || post.referenced_posts || [];
                  if (
                    Array.isArray(references) &&
                    references.some(
                      (ref: { type?: string }) => ref.type === "replied_to",
                    )
                  ) {
                    stats.arabic_replies++;
                  } else {
                    stats.arabic_posts++;
                  }
                } else if (
                  typeof post.lang === "string" &&
                  post.lang &&
                  post.lang !== "und"
                ) {
                  stats.other_language++;
                } else {
                  stats.unknown_language++;
                }
              }
              const candidate = {
                ...user,
                language_stats: stats,
                timeline_has_more: Boolean(timeline.meta?.next_token),
              };
              if (stats.arabic_posts + stats.arabic_replies > 0) {
                matched.push(candidate);
              } else if (
                !posts.length ||
                stats.unknown_language > 0 ||
                timeline.errors?.length
              ) {
                unknown.push({
                  user: candidate,
                  reason: "内容不足或部分读取失败，无法判断",
                });
              }
            } catch (error) {
              const reason =
                error instanceof HttpError ? error.message : "读取帖子失败";
              unknown.push({ user, reason });
              if (error instanceof HttpError && error.status === 429) {
                stopReason = "达到请求限制，未继续读取";
              }
            }
          }

          json(res, 200, {
            ...result,
            data: rankUsers(matched, (user) => user),
            undetermined: rankUsers(unknown, (item) => item.user),
            local_filter: {
              location,
              language,
              rule: "最近最多 10 条非转发内容中至少有 1 条被 X 标记为阿拉伯语",
              scanned_count: users.length,
              location_matched_count: matchingUsers.length,
              timeline_examined_count: examined,
              language_matched_count: matched.length,
              undetermined_count: unknown.length,
            },
          });
          return;
        }

        json(res, 200, {
          ...result,
          data: rankUsers(matchingUsers, (user) => user),
          local_filter: {
            location,
            scanned_count: users.length,
            matched_count: matchingUsers.length,
          },
        });
        return;
      }

      json(res, 200, {
        ...result,
        ...(Array.isArray(result.data) ? { data: rankUsers(result.data, (user) => user) } : {}),
      });
      return;
    }

    const maxResults = url.searchParams.get("max_results") ?? "10";
    if (match[2] !== "me" && (!/^\d+$/.test(maxResults) || Number(maxResults) < 1 || Number(maxResults) > 1000)) {
      throw new HttpError(400, "max_results 必须是 1 到 1000 的整数。");
    }
    const account = await usableAccount(match[1]);

    if (match[2] === "me") {
      json(res, 200, { data: await getMe(account.accessToken) });
      return;
    }

    const params = new URLSearchParams({ max_results: maxResults });
    const pagination = url.searchParams.get("pagination_token");
    if (pagination) params.set("pagination_token", pagination);

    const result = await xRequest(`/2/users/${match[3]}/followers?${params}`, {
      headers: { Authorization: `Bearer ${account.accessToken}` },
    });
    json(res, 200, result);
  } catch (error) {
    const e =
      error instanceof HttpError
        ? error
        : new HttpError(500, "服务内部错误，请检查本地配置和数据文件。");

    for (const [name, value] of Object.entries(e.headers))
      res.setHeader(name, value);
    json(res, e.status, { error: e.message });
  }
});

server.listen(port, "127.0.0.1", () =>
  console.log(`X 多账号服务：${origin}`),
);
