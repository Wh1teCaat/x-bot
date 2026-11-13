/** 验证 filtered stream 的规则生成与 NDJSON 增量解析。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStreamParser, filterRule } from "../scripts/mirror/mirror-stream.ts";

test("builds a rule that tracks only the user's non-retweets", () => {
  assert.equal(filterRule("Alice"), "from:Alice -is:retweet");
});

test("parses NDJSON across chunk boundaries and extracts media keys", () => {
  const tweets: { id: string; text: string; mediaKeys: string[] }[] = [];
  const parser = createStreamParser((t) => tweets.push(t));

  parser('\n');
  parser('{"id":"1","text":"hello"}\n');
  parser('not json\n{"data":{"id":"2","text":"wrapped","attachments":{"media_keys":["k1"]}}}\n');
  parser('{"id":"3","text":"partial'); // 半行，跨 chunk
  parser('"}\n');
  parser('{"id":"bad","text":"x"}\n'); // id 非数字，忽略

  assert.deepEqual(tweets, [
    { id: "1", text: "hello", mediaKeys: [] },
    { id: "2", text: "wrapped", mediaKeys: ["k1"] },
    { id: "3", text: "partial", mediaKeys: [] },
  ]);
});
