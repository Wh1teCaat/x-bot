import '../../src/runtime-config.ts';
import { readFileSync } from 'node:fs';
/** 收到回关事件后生成并发送欢迎私信。 */

/** 校验输入是否为合法的 X 数字用户 ID。 */
const validId = (value: unknown): value is string => typeof value === 'string' && /^\d{1,19}$/.test(value);

/** 确保私信首句为字面 "hello"（大小写不敏感）。 */
export function ensureHello(text: string): string {
  const trimmed = text.trim();
  if (/^hello\b/i.test(trimmed)) return trimmed;
  return `hello ${trimmed}`;
}

/** 使用 LLM 生成一句简短的欢迎私信，首句固定为 "hello"。 */
export async function generateDmReply(client: any, follower: { username: string }): Promise<string> {
  const response = await client.chat.completions.create({
    model: process.env.LLM_MODEL,
    stream: false,
    temperature: 0.8,
    max_tokens: 200,
    messages: [
      { role: 'system', content: readFileSync(new URL('./dm-skill.md', import.meta.url), 'utf8') },
      { role: 'user', content: JSON.stringify({ stage: '回关后的第一条私信', username: follower.username }) },
    ],
  });
  const choice = response.choices?.[0];
  if (choice?.finish_reason !== 'stop' || !choice.message?.content?.trim()) throw new Error('模型未返回完整私信');
  return ensureHello(choice.message.content.trim());
}

/** 封装仅连接本机授权服务发送私信的客户端。 */
export class LocalDmClient {
  origin: string;
  fetch: typeof fetch;
  /** 验证本地端口并初始化可替换的请求依赖。 */
  constructor({ port = process.env.PORT || '3000', fetchImpl = fetch } = {}) {
    if (!/^\d{1,5}$/.test(String(port)) || +port < 1 || +port > 65535) throw new Error('PORT 无效');
    this.origin = `http://127.0.0.1:${port}`;
    this.fetch = fetchImpl;
  }
  /** 通过本地服务向目标用户发送一条私信。 */
  async send(accountId: string, recipientId: string, text: string) {
    if (!validId(accountId) || !validId(recipientId)) throw new Error('账号 ID 无效');
    const response = await this.fetch(`${this.origin}/api/accounts/${accountId}/messages`, {
      method: 'POST',
      headers: { 'X-Local-Request': '1', Origin: this.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient_id: recipientId, text }),
      signal: AbortSignal.timeout(30000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || `本地服务错误 (${response.status})`) as Error & { status: number; retryAfter: string | null };
      error.status = response.status;
      error.retryAfter = response.headers.get('retry-after');
      throw error;
    }
    return body;
  }
}

/** 回关私信串行分发器：按粉丝 ID 去重，失败只记录不阻塞，链式执行。 */
export type ReplyDispatcher = {
  enqueue: (accountId: string, followerId: string, followerUsername: string) => void;
  pending: () => number;
  drain: () => Promise<void>;
};

export function createReplyDispatcher(opts: {
  generate: (follower: { username: string }) => Promise<string>;
  send: (accountId: string, recipientId: string, text: string) => Promise<unknown>;
  onError?: (message: string) => void;
  onSent?: (message: string) => void;
}): ReplyDispatcher {
  const queue = new Set<string>();
  let chain: Promise<void> = Promise.resolve();
  const { generate, send, onError, onSent } = opts;
  return {
    enqueue(accountId, followerId, followerUsername) {
      if (queue.has(followerId)) return;
      queue.add(followerId);
      chain = chain
        .then(async () => {
          const text = await generate({ username: followerUsername });
          await send(accountId, followerId, text);
          const message = `已向 @${followerUsername || followerId} 发送回关私信：${text}`;
          if (onSent) onSent(message); else console.log(message);
        })
        .catch((error) => {
          const message = `回关私信发送失败（@${followerUsername || followerId}）：${error instanceof Error ? error.message : String(error)}`;
          if (onError) onError(message); else console.error(message);
        })
        .finally(() => queue.delete(followerId));
    },
    pending() { return queue.size; },
    async drain() { await chain; },
  };
}
