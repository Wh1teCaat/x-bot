/** 验证 filtered stream 的规则生成与 NDJSON 增量解析。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStreamParser, filterRule } from "../scripts/mirror/mirror-stream.ts";

test("builds a rule that tracks only the user's non-retweets", () => {
  assert.equal(filterRule("Alice"), "from:Alice -is:retweet");
});

test("parses NDJSON across chunk boundaries and extracts media keys", () => {
  const tweets: { id: string; text: string; mediaKeys: string[]; authorId: string; authorUsername: string }[] = [];
  const parser = createStreamParser((t) => tweets.push(t));

  parser('\n');
  parser('{"id":"1","text":"hello"}\n');
  parser('not json\n{"data":{"id":"2","text":"wrapped","attachments":{"media_keys":["k1"]}}}\n');
  parser('{"id":"3","text":"partial'); // 半行，跨 chunk
  parser('"}\n');
  parser('{"id":"bad","text":"x"}\n'); // id 非数字，忽略
  parser('{"data":{"id":"4","text":"by author","author_id":"9"},"includes":{"users":[{"id":"9","username":"Alice"}]}}\n');

  assert.deepEqual(tweets, [
    { id: "1", text: "hello", mediaKeys: [], authorId: "", authorUsername: "" },
    { id: "2", text: "wrapped", mediaKeys: ["k1"], authorId: "", authorUsername: "" },
    { id: "3", text: "partial", mediaKeys: [], authorId: "", authorUsername: "" },
    { id: "4", text: "by author", mediaKeys: [], authorId: "9", authorUsername: "Alice" },
  ]);
});
