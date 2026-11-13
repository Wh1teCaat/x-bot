/** 验证OAuth 授权和本地 API 集成的行为与边界。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { once } from "node:events";

test("multi-account PKCE, persistence, refresh and follower pagination", async () => {
  let tokenCalls = 0;
  let challenge = "";
  const calls: string[] = [];
  const mock = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    calls.push(url.pathname + url.search);
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/2/oauth2/token") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      assert.equal(
        req.headers.authorization,
        `Basic ${Buffer.from("client:secret").toString("base64")}`,
      );
      if (params.get("grant_type") === "authorization_code") {
        assert.equal(
          createHash("sha256")
            .update(params.get("code_verifier")!)
            .digest("base64url"),
          challenge,
        );
        const id = params.get("code");
        tokenCalls++;
        res.end(
          JSON.stringify({
            access_token: `access${id}`,
            refresh_token: `refresh${id}`,
            expires_in: id === "1" ? 1 : 3600,
            ...(id === "2" ? { scope: "users.read follows.read" } : {}),
          }),
        );
      } else {
        assert.equal(params.get("refresh_token"), "refresh1");
        tokenCalls++;
        res.end(
          JSON.stringify({
            access_token: "new1",
            refresh_token: "rotated1",
            expires_in: 3600,
          }),
        );
      }
    } else if (url.pathname === "/2/users/me") {
      const id = req.headers.authorization === "Bearer access2" ? "2" : "1";
      res.end(
        JSON.stringify({
          data: { id, username: `user${id}`, name: `User ${id}` },
        }),
      );
    } else if (url.pathname === "/2/users/search") {
      if (url.searchParams.get("query") === "arab") {
        assert.equal(url.searchParams.get("max_results"), "10");
        assert.match(url.searchParams.get("user.fields")!, /public_metrics/);
        res.end(JSON.stringify({ data: [
          { id: "88", public_metrics: { followers_count: 10000 } },
          { id: "99", description: "مرحبا", location: "Saudi Arabia", public_metrics: { followers_count: 1 } },
        ] }));
        return;
      }
      assert.equal(url.searchParams.get("query"), "python developer");
      assert.equal(url.searchParams.get("max_results"), "10");
      assert.equal(url.searchParams.get("next_token"), "search page 2");
      assert.equal(req.headers.authorization, "Bearer new1");
      assert.match(url.searchParams.get("user.fields")!, /location/);
      res.end(
        JSON.stringify({
          data: [
            { id: "56", username: "example", location: "London, UK" },
            { id: "57", username: "other", location: "Paris" },
            { id: "58", username: "no_location", description: "مرحبا" },
            { id: "59", username: "empty", location: "London" },
            { id: "60", username: "unavailable", location: "London" },
            { id: "61", username: "english", location: "London" },
          ],
          meta: { result_count: 6, next_token: "search page 3" },
        }),
      );
    } else if (/^\/2\/users\/(56|59|60|61)\/tweets$/.test(url.pathname)) {
      assert.equal(url.searchParams.get("max_results"), "10");
      assert.equal(url.searchParams.get("exclude"), "retweets");
      assert.equal(
        url.searchParams.get("tweet.fields"),
        "lang,referenced_tweets",
      );
      if (url.pathname.includes("/56/")) {
        res.end(
          JSON.stringify({
            data: [
              { lang: "ar" },
              { lang: "ar", referenced_tweets: [{ type: "replied_to" }] },
              { lang: "en" },
              { lang: "und" },
            ],
          }),
        );
      } else if (url.pathname.includes("/59/")) {
        res.end(JSON.stringify({ meta: { result_count: 0 } }));
      } else if (url.pathname.includes("/60/")) {
        res.statusCode = 403;
        res.end(JSON.stringify({ title: "Forbidden" }));
      } else {
        res.end(JSON.stringify({ data: [{ lang: "en" }] }));
      }
    } else if (url.pathname === "/2/users/by") {
      assert.equal(url.searchParams.get("usernames"), "alice,bob");
      res.end(JSON.stringify({ data: [{ id: "123", username: "alice" }, { id: "124", username: "bob" }] }));
    } else if (url.pathname === "/2/users/1/following" && req.method === "GET") {
      assert.equal(url.searchParams.get("max_results"), "1000");
      res.end(JSON.stringify({ data: [{ id: "111" }], meta: { result_count: 1 } }));
    } else if (url.pathname === "/2/users/1/following") {
      assert.equal(req.method, "POST");
      assert.equal(req.headers.authorization, "Bearer new1");
      let body = "";
      for await (const chunk of req) body += chunk;
      const { target_user_id } = JSON.parse(body);
      if (target_user_id === "429") {
        res.statusCode = 429;
        res.setHeader("retry-after", "20");
        res.end(JSON.stringify({ title: "Too Many Requests" }));
      } else {
        assert.ok(["123", "124"].includes(target_user_id));
        res.end(JSON.stringify({ data: { following: false, pending_follow: true } }));
      }
    } else if (url.pathname === "/2/users/99/followers") {
      assert.equal(url.searchParams.get("max_results"), "1");
      assert.equal(url.searchParams.get("user.fields"), "connection_status");
      assert.equal(req.headers.authorization, "Bearer new1");
      if (!url.searchParams.has("pagination_token")) {
        res.end(JSON.stringify({ data: [{ id: "111" }], meta: { next_token: "next" } }));
      } else {
        assert.equal(url.searchParams.get("pagination_token"), "next");
        res.end(JSON.stringify({ data: [{ id: "124" }] }));
      }
    } else if (url.pathname === "/2/users/123/followers") {
      assert.equal(url.searchParams.get("max_results"), "500");
      assert.equal(url.searchParams.get("pagination_token"), "next page");
      assert.equal(req.headers.authorization, "Bearer new1");
      res.end(
        JSON.stringify({
          data: [{ id: "42" }],
          meta: { result_count: 1, next_token: "next2" },
        }),
      );
    } else if (url.pathname === "/2/tweets" && req.method === "POST") {
      assert.equal(req.headers.authorization, "Bearer new1");
      let body = "";
      for await (const chunk of req) body += chunk;
      const { text, media } = JSON.parse(body);
      assert.ok(text);
      if (media) assert.deepEqual(media.media_ids, ["1234567890123456789"]);
      res.end(JSON.stringify({ data: { id: "5000", text } }));
    } else if (url.pathname === "/2/tweets/777") {
      assert.equal(req.headers.authorization, "Bearer new1");
      res.end(JSON.stringify({ data: { id: "777" }, includes: { media: [{ media_key: "k1", type: "photo", url: "https://pbs.twimg.com/media/foo.jpg" }, { media_key: "k2", type: "video" }] } }));
    } else if (url.pathname === "/2/users/77/tweets") {
      assert.equal(req.headers.authorization, "Bearer new1");
      assert.equal(url.searchParams.get("max_results"), "100");
      assert.equal(url.searchParams.get("since_id"), "900");
      assert.equal(url.searchParams.get("exclude"), "retweets");
      res.end(JSON.stringify({ data: [{ id: "777", text: "mirror me" }], meta: { newest_id: "777" } }));
    } else if (url.pathname === "/2/tweets/search/stream/rules" && req.method === "GET") {
      assert.equal(req.headers.authorization, "Bearer new1");
      res.end(JSON.stringify({ data: [] }));
    } else if (url.pathname === "/2/tweets/search/stream/rules" && req.method === "POST") {
      res.end(JSON.stringify({ data: [{ id: "r1", value: "from:Alice -is:retweet" }] }));
    } else if (url.pathname === "/2/tweets/search/stream") {
      assert.equal(req.headers.authorization, "Bearer new1");
      res.write('{"id":"77-9","text":"streamed"}\n');
      res.write("\n");
      res.end('{"id":"77-10","text":"streamed2"}\n');
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  const mockPort = (mock.address() as any).port;
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as any).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const dir = mkdtempSync(join(tmpdir(), "x-oauth-test-"));
  const child = spawn(process.execPath, ["src/server.ts"], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      X_CLIENT_ID: "client",
      X_CLIENT_SECRET: "secret",
      X_REDIRECT_URI: `${base}/oauth/callback`,
      X_TEST_API_BASE: `http://127.0.0.1:${mockPort}`,
      X_TEST_AUTH_BASE: `http://127.0.0.1:${mockPort}`,
      X_TEST_DATA_DIR: dir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await Promise.race([
      once(child.stdout!, "data"),
      once(child, "exit").then(() => {
        throw new Error("server exited early");
      }),
    ]);
    const home = await fetch(base);
    assert.equal(home.headers.get("referrer-policy"), "same-origin");
    const csp = home.headers.get("content-security-policy") || "";
    assert.match(csp, /form-action 'self' https:\/\/x\.com(?:;|$)/);

    async function authorize(id: string) {
      const start = await fetch(`${base}/oauth/start`, {
        method: "POST",
        headers: { Origin: base },
        redirect: "manual",
      });
      assert.equal(start.status, 303);
      const location = new URL(start.headers.get("location")!);
      assert.equal(location.searchParams.get("code_challenge_method"), "S256");
      assert.match(location.searchParams.get("scope")!, /offline.access/);
      assert.match(location.searchParams.get("scope")!, /follows.write/);
      assert.doesNotMatch(location.searchParams.get("scope")!, /\bdm\./);
      challenge = location.searchParams.get("code_challenge")!;
      const state = location.searchParams.get("state")!;
      const callback = await fetch(
        `${base}/oauth/callback?state=${state}&code=${id}`,
        {
          headers: { Cookie: start.headers.get("set-cookie")!.split(";")[0] },
          redirect: "manual",
        },
      );
      assert.equal(callback.status, 303);
      const replay = await fetch(
        `${base}/oauth/callback?state=${state}&code=${id}`,
        { headers: { Cookie: start.headers.get("set-cookie")!.split(";")[0] } },
      );
      assert.equal(replay.status, 400);
    }
    await authorize("1");
    await authorize("2");
    const header = { "X-Local-Request": "1" };
    const accounts = (await (
      await fetch(`${base}/api/accounts`, { headers: header })
    ).json()) as any;
    assert.deepEqual(
      accounts.accounts.map((a: any) => a.user.id),
      ["1", "2"],
    );
    assert.equal(JSON.stringify(accounts).includes("access1"), false);
    assert.equal(JSON.stringify(accounts).includes("access2"), false);
    const sqlite = readFileSync(join(dir, "accounts.sqlite"));
    for (const secret of ["access1", "refresh1", "refresh2"]) {
      assert.equal(sqlite.includes(Buffer.from(secret)), false);
    }
    const [a, b] = await Promise.all([
      fetch(`${base}/api/accounts/1/me`, { headers: header }),
      fetch(`${base}/api/accounts/1/me`, { headers: header }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(tokenCalls, 3);
    const followHeaders = { ...header, Origin: base };
    const followPath = `${base}/api/accounts/1/users/123/follow`;
    assert.equal((await fetch(followPath, { method: "POST", headers: header })).status, 403);
    assert.equal((await fetch(followPath, { method: "POST", headers: { Origin: base } })).status, 403);
    assert.equal((await fetch(`${base}/api/accounts/1/users/1/follow`, { method: "POST", headers: followHeaders })).status, 400);
    const noScope = await fetch(`${base}/api/accounts/2/users/123/follow`, { method: "POST", headers: followHeaders });
    assert.equal(noScope.status, 403);
    assert.match((await noScope.json() as any).error, /重新授权/);
    const followResponse = await fetch(followPath, { method: "POST", headers: followHeaders });
    assert.equal(followResponse.status, 200);
    assert.equal((await followResponse.json() as any).data.pending_follow, true);
    const beforeCached = calls.length;
    const cached = await fetch(followPath, { method: "POST", headers: followHeaders });
    assert.equal((await cached.json() as any).cached, true);
    assert.equal(calls.length, beforeCached);
    const lookup = await fetch(`${base}/api/accounts/1/users/by?usernames=alice%2Cbob`, { headers: header });
    assert.equal(lookup.status, 200);
    assert.equal(((await lookup.json()) as any).data.length, 2);
    assert.equal((await fetch(`${base}/api/accounts/1/users/by?usernames=bad%2Fname`, { headers: header })).status, 400);
    const rateLimited = await fetch(`${base}/api/accounts/1/users/429/follow`, { method: "POST", headers: followHeaders });
    assert.equal(rateLimited.status, 429);
    assert.equal(rateLimited.headers.get("retry-after"), "20");
    const againLimited = await fetch(`${base}/api/accounts/1/users/429/follow`, { method: "POST", headers: followHeaders });
    assert.equal(againLimited.status, 429);
    const autoUrl = `${base}/api/accounts/1/follow-arab-follower`;
    assert.equal((await fetch(autoUrl, { method: "POST", headers: header })).status, 403);
    const callCount = calls.length;
    const autoResponse = await fetch(autoUrl, { method: "POST", headers: followHeaders });
    assert.equal(autoResponse.status, 200);
    const autoResult = await autoResponse.json() as any;
    assert.equal(autoResult.blogger.id, "99");
    assert.equal(autoResult.follower.id, "124");
    assert.equal(autoResult.follow.data.pending_follow, true);
    assert.equal(autoResult.skipped, 1);
    assert.deepEqual(calls.slice(callCount).map((path) => path.split("?")[0]), ["/2/users/1/following", "/2/users/search", "/2/users/99/followers", "/2/users/99/followers", "/2/users/1/following"]);
    const search = await fetch(
      `${base}/api/accounts/1/search?query=python%20developer&next_token=search%20page%202`,
      { headers: header },
    );
    assert.equal(search.status, 200);
    const unfiltered = (await search.json()) as any;
    assert.equal(unfiltered.meta.next_token, "search page 3");
    assert.equal(unfiltered.data.length, 6);
    assert.equal(unfiltered.data[0].id, "58");

    const filtered = await fetch(
      `${base}/api/accounts/1/search?query=python%20developer&next_token=search%20page%202&location=lOnDoN`,
      { headers: header },
    );
    const filteredResult = (await filtered.json()) as any;
    assert.equal(filtered.status, 200);
    assert.deepEqual(
      filteredResult.data.map((user: any) => user.id),
      ["56", "59", "60", "61"],
    );
    assert.deepEqual(filteredResult.local_filter, {
      location: "lOnDoN",
      scanned_count: 6,
      matched_count: 4,
    });
    assert.equal(filteredResult.meta.result_count, 6);
    assert.equal(filteredResult.meta.next_token, "search page 3");
    const languageResponse = await fetch(
      `${base}/api/accounts/1/search?query=python%20developer&next_token=search%20page%202&location=London&language=ar`,
      { headers: header },
    );
    const languageResult = (await languageResponse.json()) as any;
    assert.equal(languageResponse.status, 200);
    assert.deepEqual(
      languageResult.data.map((user: any) => user.id),
      ["56"],
    );
    assert.deepEqual(languageResult.data[0].language_stats, {
      total: 4,
      arabic_posts: 1,
      arabic_replies: 1,
      other_language: 1,
      unknown_language: 1,
    });
    assert.deepEqual(
      languageResult.undetermined.map((item: any) => item.user.id),
      ["59", "60"],
    );
    assert.equal(languageResult.meta.next_token, "search page 3");
    assert.equal(languageResult.local_filter.location_matched_count, 4);
    assert.equal(languageResult.local_filter.language_matched_count, 1);
    assert.equal(
      calls.some((path) => path.startsWith("/2/users/57/tweets")),
      false,
    );

    const languageOnly = await fetch(
      `${base}/api/accounts/1/search?query=python%20developer&next_token=search%20page%202&language=ar`,
      { headers: header },
    );
    const languageOnlyResult = (await languageOnly.json()) as any;
    assert.equal(languageOnly.status, 200);
    assert.equal(languageOnlyResult.local_filter.location_matched_count, 6);
    assert.equal(languageOnlyResult.local_filter.language_matched_count, 1);

    const invalidSearch = await fetch(
      `${base}/api/accounts/1/search?query=%E4%B8%AD%E6%96%87`,
      { headers: header },
    );
    assert.equal(invalidSearch.status, 400);

    const followers = await fetch(
      `${base}/api/accounts/1/users/123/followers?max_results=500&pagination_token=next%20page`,
      { headers: header },
    );
    assert.equal(((await followers.json()) as any).meta.next_token, "next2");
    assert.equal(
      (await fetch(`${base}/api/accounts/1/users/123/followers?max_results=1001`, { headers: header })).status,
      400,
    );
    assert.equal(
      (await fetch(`${base}/api/recommendations`, { headers: header })).status,
      501,
    );
    assert.equal((await fetch(`${base}/api/accounts`)).status, 403);
    assert.equal(
      (
        await fetch(`${base}/oauth/start`, {
          method: "POST",
          headers: { Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    assert(
      calls.includes(
        "/2/users/123/followers?max_results=500&pagination_token=next+page",
      ),
    );

    // 发帖与目标时间线端点：账号 2 无 tweet.write，账号 1 具备。
    assert.equal((await fetch(`${base}/api/accounts/2/tweets`, { method: "POST", headers: followHeaders, body: JSON.stringify({ text: "mirror me" }) })).status, 403);
    assert.equal((await fetch(`${base}/api/accounts/1/tweets`, { method: "POST", headers: followHeaders, body: JSON.stringify({ text: "" }) })).status, 400);
    assert.equal((await fetch(`${base}/api/accounts/1/tweets`, { method: "POST", headers: followHeaders, body: JSON.stringify({ text: "x".repeat(281) }) })).status, 400);
    const posted = await fetch(`${base}/api/accounts/1/tweets`, { method: "POST", headers: { ...followHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ text: "mirror me" }) });
    assert.equal(posted.status, 200);
    assert.equal(((await posted.json()) as any).data.id, "5000");
    const timeline = await fetch(`${base}/api/accounts/1/users/77/tweets?since_id=900&exclude=retweets`, { headers: header });
    assert.equal(timeline.status, 200);
    assert.equal(((await timeline.json()) as any).data[0].text, "mirror me");
    const streamRes = await fetch(`${base}/api/accounts/1/stream/tweets?username=Alice`, { headers: header });
    assert.equal(streamRes.status, 200);
    const streamBody = await streamRes.text();
    assert.match(streamBody, /streamed/);
    assert.match(streamBody, /streamed2/);
    assert.equal((await fetch(`${base}/api/accounts/2/stream/tweets?username=Alice`, { headers: header })).status, 403);

    // 发帖带媒体、媒体上传校验、单帖媒体查询。
    const postedWithMedia = await fetch(`${base}/api/accounts/1/tweets`, { method: "POST", headers: { ...followHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ text: "with image", media_ids: ["1234567890123456789"] }) });
    assert.equal(postedWithMedia.status, 200);
    assert.equal((await fetch(`${base}/api/accounts/1/tweets`, { method: "POST", headers: followHeaders, body: JSON.stringify({ text: "x", media_ids: ["bad"] }) })).status, 400);
    assert.equal((await fetch(`${base}/api/accounts/2/media`, { method: "POST", headers: followHeaders, body: JSON.stringify({ url: "https://pbs.twimg.com/x.jpg" }) })).status, 403);
    assert.equal((await fetch(`${base}/api/accounts/1/media`, { method: "POST", headers: followHeaders, body: JSON.stringify({ url: "https://evil.example/x.jpg" }) })).status, 400);
    const tweetMedia = await fetch(`${base}/api/accounts/1/tweets/777/media`, { headers: header });
    assert.equal(tweetMedia.status, 200);
    assert.deepEqual(((await tweetMedia.json()) as any).data.images, ["https://pbs.twimg.com/media/foo.jpg"]);
  } finally {
    child.kill();
    mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
