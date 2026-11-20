import { DatabaseSync } from 'node:sqlite';
import { AccountStore } from '../../src/account-store.ts';
import { generateCustomerReply, type LocalDmClient } from './dm-reply.ts';
import { createXChatReader } from './xchat-decrypt.ts';
import type { ChatEvent, DmEvent } from './activity-stream.ts';

/** 账号和对话隔离；消息事件先持久化去重，再由串行队列处理。 */
export function createCustomerService(opts: { llm: () => any; dm: Pick<LocalDmClient, 'send'>; dataDir?: string; createReader?: typeof createXChatReader }) {
  const dir = opts.dataDir || '.data';
  const db = new DatabaseSync(`${dir}/customer-service.sqlite`);
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, peer_id TEXT NOT NULL,
      event_key TEXT UNIQUE, role TEXT NOT NULL, text TEXT NOT NULL,
      state TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS welcomes (
      account_id TEXT NOT NULL, peer_id TEXT NOT NULL, state TEXT NOT NULL,
      PRIMARY KEY(account_id, peer_id)
    );`);
  const readers = new Map<string, { pin: string; reader: Awaited<ReturnType<typeof createXChatReader>> | null; failed: boolean }>();
  let chain: Promise<void> = Promise.resolve();
  let stopped = false;
  function pinFor(accountId: string) {
    const store = new AccountStore(dir);
    try { return store.getXChatPin(accountId); } finally { store.close(); }
  }
  function save(account: string, peer: string, eventKey: string | null, role: string, text: string, state: string) {
    return db.prepare('INSERT OR IGNORE INTO messages(account_id,peer_id,event_key,role,text,state,created_at) VALUES(?,?,?,?,?,?,?)').run(account, peer, eventKey, role, text, state, new Date().toISOString());
  }
  async function chatReader(accountId: string, pin: string) {
    let state = readers.get(accountId);
    if (state && state.pin !== pin) { state.reader?.close(); readers.delete(accountId); state = undefined; }
    if (state?.reader) return state.reader;
    const store = new AccountStore(dir);
    try { if (store.isXChatPinBlocked(accountId)) throw new Error('账号 XChat 已暂停解锁，请检查后重新导入 PIN'); } finally { store.close(); }
    state = { pin, reader: null, failed: true }; readers.set(accountId, state);
    const bytes = new TextEncoder().encode(pin);
    try { state.reader = await (opts.createReader || createXChatReader)(accountId, bytes); state.failed = false; return state.reader; }
    catch (error) { const accountStore = new AccountStore(dir); try { accountStore.blockXChatPin(accountId); } finally { accountStore.close(); } throw error; }
    finally { bytes.fill(0); }
  }
  function enqueue(account: string, peer: string, eventKey: string, getText: (pin: string) => Promise<string | null>) {
    if (stopped) return;
    const pin = pinFor(account);
    if (!pin) return;
    if (!save(account, peer, eventKey, 'user', '', 'received').changes) return;
    chain = chain.then(async () => {
      const text = await getText(pin);
      if (!text) { db.prepare("UPDATE messages SET state='ignored' WHERE event_key=?").run(eventKey); return; }
      db.prepare("UPDATE messages SET text=?,state='processing' WHERE event_key=?").run(text, eventKey);
      const messages = (db.prepare("SELECT role,text FROM (SELECT id,role,text FROM messages WHERE account_id=? AND peer_id=? AND text<>'' ORDER BY id DESC LIMIT 20) ORDER BY id").all(account, peer) as Array<{role: string; text: string}>);
      const reply = await generateCustomerReply(opts.llm(), messages);
      // 发出请求后结果可能不明确；状态保留以供人工核查，不自动重复发送。
      db.prepare("UPDATE messages SET state='sending' WHERE event_key=?").run(eventKey);
      await opts.dm.send(account, peer, reply);
      save(account, peer, null, 'assistant', reply, 'sent');
      db.prepare("UPDATE messages SET state='done' WHERE event_key=?").run(eventKey);
      console.log(`客服回复已发送：账号 ${account}，对方 ${peer}`);
    }).catch(() => {
      db.prepare("UPDATE messages SET state=CASE WHEN state='sending' THEN 'uncertain' ELSE 'failed' END WHERE event_key=?").run(eventKey);
      console.error(`客服处理失败：账号 ${account}，对方 ${peer}；请检查授权、密钥和日志后人工核查。`);
    });
  }
  return {
    hasPin(account: string) { return !!pinFor(account); },
    reserveWelcome(account: string, peer: string) { return !!db.prepare("INSERT OR IGNORE INTO welcomes VALUES (?,?,'pending')").run(account, peer).changes; },
    recordWelcome(account: string, peer: string, text: string) { save(account, peer, null, 'assistant', text, 'sent'); db.prepare("UPDATE welcomes SET state='sent' WHERE account_id=? AND peer_id=?").run(account, peer); },
    dm(event: DmEvent) { enqueue(event.accountId, event.senderId, `dm:${event.accountId}:${event.messageId}`, async () => event.text); },
    chat(event: ChatEvent) {
      const participants = event.conversationId.split(':');
      if (participants.length !== 2 || !participants.includes(event.accountId) || !participants.includes(event.senderId)) return;
      enqueue(event.accountId, event.senderId, `chat:${event.accountId}:${event.messageId}`, async pin => (await chatReader(event.accountId, pin)).decrypt(event));
    },
    async close() { stopped = true; await chain; for (const state of readers.values()) state.reader?.close(); db.close(); },
  };
}
