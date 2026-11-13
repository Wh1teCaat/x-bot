/** filtered stream 解析：把 X 推送的 NDJSON 流增量切分为单条推文。 */

export type StreamTweet = { id: string; text: string; mediaKeys: string[] };

/** 生成只跟踪指定用户原创（排除转发）的过滤规则。 */
export function filterRule(username: string): string {
  return `from:${username} -is:retweet`;
}

/** 增量解析器：缓存跨 chunk 的半行，逐行解析 JSON 并回调推文（含媒体 key）。 */
export function createStreamParser(onTweet: (tweet: StreamTweet) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue; // 保活空行
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }
      const tweet = obj?.data ?? obj;
      if (tweet && typeof tweet.id === "string" && /^\d{1,19}$/.test(tweet.id)) {
        const keys = Array.isArray(tweet.attachments?.media_keys) ? tweet.attachments.media_keys.filter((k: unknown) => typeof k === "string") : [];
        onTweet({ id: tweet.id, text: typeof tweet.text === "string" ? tweet.text : "", mediaKeys: keys });
      }
    }
  };
}

