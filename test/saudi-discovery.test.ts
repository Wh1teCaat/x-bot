/** 验证地区与语言候选筛选的行为与边界。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  discoverSaudiAccount,
  SAUDI_KEYWORDS,
} from "../src/saudi-discovery.ts";

test("collects bounded pages, deduplicates accounts and returns Arabic matches", async () => {
  const searches: string[] = [];
  const timelines: string[] = [];
  const result = await discoverSaudiAccount({
    search: async (keyword, token) => {
      searches.push(`${keyword}:${token || "first"}`);
      if (keyword === "Saudi") {
        return token
          ? {
              data: [{ id: "1", location: "Riyadh" }],
              meta: { next_token: "third" },
            }
          : {
              data: [{ id: "1", location: "Riyadh" }],
              meta: { next_token: "second" },
            };
      }
      if (keyword === "Riyadh")
        return {
          data: [
            { id: "1", location: "Riyadh" },
            { id: "2", location: "Paris" },
          ],
          meta: {},
        };
      return { data: [], meta: {} };
    },
    timeline: async (id) => {
      timelines.push(id);
      return {
        data: [
          { lang: "ar", referenced_tweets: [{ type: "replied_to" }] },
          { lang: "en" },
        ],
      };
    },
  });

  assert.equal(result.status, "matched");
  assert.equal(result.level, 1);
  assert.equal(result.search_truncated, true);
  assert.equal(result.search_requests, SAUDI_KEYWORDS.length + 1);
  assert.equal(result.scanned_unique, 2);
  assert.deepEqual(timelines, ["1"]);
  assert.deepEqual((result.data[0] as any).keywords, ["Saudi", "Riyadh"]);
  assert.equal(
    (result.data[0] as any).language_evidence.stats.arabic_replies,
    1,
  );
  assert(!searches.includes("Saudi:third"));
});

test("falls back to location and then keyword based only on examined sample", async () => {
  const location = await discoverSaudiAccount({
    search: async () => ({ data: [{ id: "1", location: "الرياض" }], meta: {} }),
    timeline: async () => ({ data: [{ lang: "en" }] }),
  });
  assert.equal(location.level, 2);
  assert.equal(location.data.length, 1);
  assert.equal(location.timeline_requests, 1);

  const keyword = await discoverSaudiAccount({
    search: async () => ({ data: [{ id: "2", location: "Paris" }], meta: {} }),
    timeline: async () => {
      throw new Error("must not read nonmatching location");
    },
  });
  assert.equal(keyword.level, 3);
  assert.equal(keyword.timeline_requests, 0);
});

test("never treats inaccessible or incomplete language evidence as a negative", async () => {
  for (const timeline of [
    async () => ({ data: [] }),
    async () => ({ data: [{ lang: "en" }, { lang: "und" }] }),
    async () => {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    },
  ]) {
    const result = await discoverSaudiAccount({
      search: async () => ({
        data: [{ id: "3", location: "Saudi Arabia" }],
        meta: {},
      }),
      timeline,
    });
    assert.equal(result.status, "undetermined");
    assert.equal(result.data.length, 0);
    assert.equal(result.undetermined?.length, 1);
  }
});

test("stops on search error and preserves timeline budget and rate-limit state", async () => {
  let searches = 0;
  const failed = await discoverSaudiAccount({
    search: async () => {
      searches++;
      throw Object.assign(new Error("rate limited"), { status: 429 });
    },
    timeline: async () => ({ data: [] }),
  });
  assert.equal(failed.status, "error");
  assert.equal(failed.error?.status, 429);
  assert.equal(searches, 1);

  let calls = 0;
  const limited = await discoverSaudiAccount({
    search: async () => ({
      data: Array.from({ length: 12 }, (_, i) => ({
        id: String(i + 1),
        location: "Riyadh",
      })),
      meta: {},
    }),
    timeline: async () => {
      calls++;
      return { data: [{ lang: "en" }] };
    },
  });
  assert.equal(limited.status, "undetermined");
  assert.equal(calls, 10);
  assert.equal(limited.undetermined?.length, 2);

  let rateCalls = 0;
  const rateLimited = await discoverSaudiAccount({
    search: async () => ({
      data: [
        { id: "1", location: "Riyadh" },
        { id: "2", location: "Riyadh" },
      ],
      meta: {},
    }),
    timeline: async () => {
      rateCalls++;
      throw Object.assign(new Error("rate limited"), { status: 429 });
    },
  });
  assert.equal(rateLimited.status, "undetermined");
  assert.equal(rateLimited.rate_limited, true);
  assert.equal(rateCalls, 1);
  assert.equal(rateLimited.undetermined?.length, 2);
});
