/** 使用官方 SDK 解密已授权账号收到的 XChat 消息。 */
import { createChat, type ChatWithJuicebox, type SigningKeyEntry } from '@xdevplatform/chat-xdk';
import { AccountStore } from '../../src/account-store.ts';
import type { ChatEvent } from './activity-stream.ts';
import { fetchXWithCircuit } from '../../src/x-api-circuit.ts';

type PublicKey = { public_key_version: string; public_key: string; signing_public_key: string; identity_public_key_signature: string; juicebox_config?: any };

export async function createXChatReader(accountId: string, pin: Uint8Array, port = process.env.PORT || '3000') {
  if (!/^\d{1,5}$/.test(String(port)) || +port < 1 || +port > 65535) throw new Error('PORT 无效');
  async function request(path: string): Promise<any> {
    const local = await fetch(`http://127.0.0.1:${port}/api/accounts/${accountId}/me`, { headers: { 'X-Local-Request': '1' }, signal: AbortSignal.timeout(30000) });
    if (!local.ok) throw new Error(`本地账号授权检查失败（HTTP ${local.status}）`);
    const store = new AccountStore('.data');
    let token: string;
    try {
      const account = store.getByUuid(accountId);
      if (!account?.authenticated || !account.accessToken) throw new Error('账号没有有效用户令牌');
      token = account.accessToken;
    } finally { store.close(); }
    const res = await fetchXWithCircuit(`https://api.x.com/2${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`XChat 接口请求失败（HTTP ${res.status}，${path.split('?')[0]}）`);
    return res.json();
  }
  async function keys(userId: string): Promise<PublicKey[]> {
    const response = await request(`/users/${userId}/public_keys`);
    if (!Array.isArray(response.data) || !response.data.length || response.errors?.length) throw new Error('无法读取 XChat 公钥记录');
    return response.data;
  }
  const ownKeys = await keys(accountId);
  const ownKey = ownKeys.find(k => k.juicebox_config && k.public_key_version);
  if (!ownKey) throw new Error('账号没有可用的 XChat 安全密钥备份，无法恢复已有密钥');
  const config = ownKey.juicebox_config;
  const tokens = new Map<string, string>();
  if (Array.isArray(config.token_map)) for (const entry of config.token_map) {
    if (typeof entry?.key === 'string' && typeof entry?.value?.token === 'string') tokens.set(entry.key.toLowerCase().replaceAll('-', ''), entry.value.token);
  }
  if (!tokens.size) throw new Error('XChat 密钥备份未提供可用的 realm 授权信息');
  const chat = await createChat({ juiceboxConfig: JSON.stringify(config), getAuthToken: async realm => {
    const token = tokens.get(realm.toLowerCase().replaceAll('-', ''));
    if (!token) throw new Error('缺少密钥备份 realm 授权');
    return token;
  } });
  try { await chat.unlock(pin); } finally { pin.fill(0); }
  chat.setIdentity({ userId: accountId, signingKeyVersion: String(ownKey.public_key_version) });
  chat.setCacheKeys(true);
  const initialized = new Set<string>();
  async function addKeys(userId: string, records?: PublicKey[]) {
    const list = records || await keys(userId);
    const entries: SigningKeyEntry[] = list.filter(k => k.public_key && k.signing_public_key && k.identity_public_key_signature && k.public_key_version).map(k => ({ userId, publicKeyVersion: String(k.public_key_version), publicKey: k.signing_public_key, identityPublicKey: k.public_key, identityPublicKeySignature: k.identity_public_key_signature }));
    if (!entries.length) throw new Error('无法获取完整的签名公钥');
    chat.addSigningKeys(entries);
  }
  await addKeys(accountId, ownKeys);
  return {
    async decrypt(message: ChatEvent) {
      if (!message.encodedEvent) throw new Error('事件缺少加密消息字段');
      await addKeys(message.senderId);
      if (!initialized.has(message.conversationId)) {
        const id = encodeURIComponent(message.conversationId.replaceAll(':', '-'));
        const history = await request(`/chat/conversations/${id}/events?max_results=100`);
        const changes: unknown = history.meta?.conversation_key_events;
        if (Array.isArray(changes) && changes.length) {
          const result = chat.decryptEvents({ events: changes.filter((e): e is string => typeof e === 'string') });
          if (Object.keys(result.unverifiedKeyChanges).length || Object.keys(result.undecryptableKeyChanges).length) throw new Error('会话密钥验证或解密失败');
        }
        initialized.add(message.conversationId);
      }
      if (message.conversationKeyChangeEvent) {
        const result = chat.decryptEvents({ events: [message.conversationKeyChangeEvent] });
        if (Object.keys(result.errors).length || Object.keys(result.unverifiedKeyChanges).length || Object.keys(result.undecryptableKeyChanges).length) throw new Error('会话密钥变更验证或解密失败');
      }
      const event = chat.decryptEvent({ eventB64: message.encodedEvent });
      if (event.verified !== true || event.senderId !== message.senderId || event.conversationId !== message.conversationId) throw new Error('消息签名或身份校验失败');
      if (event.type !== 'message' || event.content?.contentType !== 'text' || typeof event.content.text !== 'string') return null;
      return event.content.text;
    },
    close() { chat.lock(); },
  };
}
