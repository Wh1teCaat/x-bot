import { DatabaseSync } from 'node:sqlite';
import { AccountStore } from '../../src/account-store.ts';
import { generateCustomerReply, generateDmReply, type LocalDmClient } from './dm-reply.ts';
import { createXChatReader } from './xchat-decrypt.ts';
import type { ChatEvent, DmEvent } from './activity-stream.ts';

const FOLLOWUP_TEXT = 'If you are interested in clothing, please contact our customer service on WhatsApp: +852 5712 7467. They will be happy to help.';
const hasWhatsAppNumber = (text: string) => text.replace(/\D/g, '').includes('85257127467');
/** 只记录安全的错误类别，不输出消息内容、模型响应、凭证或请求地址。 */
function failureDetail(error: any): string {
  const parts: string[] = [];
  if (Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) parts.push(`HTTP ${error.status}`);
  if (['stop', 'length', 'content_filter', 'tool_calls', 'function_call', 'missing'].includes(error?.completionReason)) parts.push(`模型结束状态 ${error.completionReason}`);
  const code = error?.code || error?.cause?.code;
  if (['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)) parts.push(`网络 ${code}`);
  if (error?.name === 'TimeoutError' || error?.name === 'APIConnectionTimeoutError') parts.push('请求超时');
  return parts.length ? parts.join('，') : '具体原因未识别';
}

/** 账号和对话隔离；入站消息、欢迎与超时跟进共享队列。 */
export function createCustomerService(opts: { llm: () => any; dm: Pick<LocalDmClient, 'send'>; dataDir?: string; createReader?: typeof createXChatReader; followUpMs?: number; now?: () => number; requireConnection?: boolean }) {
  const dir = opts.dataDir || '.data', now = opts.now || Date.now, delayMs = opts.followUpMs ?? 5 * 60_000;
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
    );
    CREATE TABLE IF NOT EXISTS customer_followups (
      account_id TEXT NOT NULL, peer_id TEXT NOT NULL, anchor_id INTEGER NOT NULL,
      due_at INTEGER NOT NULL, state TEXT NOT NULL,
      PRIMARY KEY(account_id, peer_id)
    );`);
  const readers = new Map<string, { pin: string; reader: Awaited<ReturnType<typeof createXChatReader>> | null; failed: boolean }>();
  let chain: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queuedFollowups = new Set<string>();
  let stopped = false;
  let connected = !opts.requireConnection, monitoringStarted = !opts.requireConnection;
  function pinFor(accountId: string) {
    const store = new AccountStore(dir);
    try { return store.getXChatPin(accountId); } finally { store.close(); }
  }
  function save(account: string, peer: string, eventKey: string | null, role: string, text: string, state: string) {
    return db.prepare('INSERT OR IGNORE INTO messages(account_id,peer_id,event_key,role,text,state,created_at) VALUES(?,?,?,?,?,?,?)').run(account, peer, eventKey, role, text, state, new Date(now()).toISOString());
  }
  function latestUserId(account: string, peer: string): number {
    return Number((db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM messages WHERE account_id=? AND peer_id=? AND role='user'").get(account, peer) as { id: number }).id);
  }
  function hasIntroduced(account: string, peer: string): boolean {
    const sent = db.prepare("SELECT text FROM messages WHERE account_id=? AND peer_id=? AND role='assistant' AND state='sent'").all(account, peer) as Array<{ text: string }>;
    if (sent.some(row => hasWhatsAppNumber(row.text))) return true;
    // 发送结果未知时不能自动再次推送，避免重复发出。
    return !!db.prepare("SELECT 1 FROM customer_followups WHERE account_id=? AND peer_id=? AND state IN ('sending','uncertain')").get(account, peer);
  }
  function cancelFollowup(account: string, peer: string) {
    db.prepare("UPDATE customer_followups SET state='cancelled' WHERE account_id=? AND peer_id=? AND state IN ('pending','unverified')").run(account, peer);
    armTimer();
  }
  function scheduleFollowup(account: string, peer: string, anchor: number, baselineUser: number, text: string) {
    if (!pinFor(account) || hasWhatsAppNumber(text) || hasIntroduced(account, peer) || latestUserId(account, peer) !== baselineUser) return;
    if (opts.requireConnection && !connected) { console.warn(`事件流未连接，无法确认对方后续回复；账号 ${account}，对方 ${peer} 的超时跟进未安排。`); return; }
    db.prepare(`INSERT INTO customer_followups VALUES (?,?,?,?, 'pending') ON CONFLICT(account_id,peer_id)
      DO UPDATE SET anchor_id=excluded.anchor_id,due_at=excluded.due_at,state='pending'`).run(account, peer, anchor, now() + delayMs);
    armTimer();
  }
  function armTimer() {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (stopped || !connected || !monitoringStarted) return;
    const pending = db.prepare("SELECT account_id,peer_id,due_at FROM customer_followups WHERE state='pending' ORDER BY due_at").all() as Array<{account_id: string; peer_id: string; due_at: number}>;
    const next = pending.find(row => !queuedFollowups.has(`${row.account_id}:${row.peer_id}`));
    if (!next) return;
    timer = setTimeout(() => { timer = undefined; enqueueDueFollowups(); }, Math.max(0, Math.min(2_147_483_647, Number(next.due_at) - now())));
    timer.unref?.();
  }
  function enqueueDueFollowups() {
    if (stopped || !connected || !monitoringStarted) return;
    const due = db.prepare("SELECT account_id,peer_id,anchor_id FROM customer_followups WHERE state='pending' AND due_at<=? ORDER BY due_at").all(now()) as Array<{account_id: string; peer_id: string; anchor_id: number}>;
    for (const row of due) {
      const key = `${row.account_id}:${row.peer_id}`;
      if (queuedFollowups.has(key)) continue;
      queuedFollowups.add(key);
      chain = chain.then(async () => {
        if (stopped || !connected) return;
        if (!pinFor(row.account_id)) { cancelFollowup(row.account_id, row.peer_id); return; }
        if (hasIntroduced(row.account_id, row.peer_id)) { cancelFollowup(row.account_id, row.peer_id); return; }
        const latest = db.prepare('SELECT id,role FROM messages WHERE account_id=? AND peer_id=? ORDER BY id DESC LIMIT 1').get(row.account_id, row.peer_id) as { id: number; role: string } | undefined;
        if (!latest || latest.id !== row.anchor_id || latest.role !== 'assistant') { cancelFollowup(row.account_id, row.peer_id); return; }
        const reserved = db.prepare("UPDATE customer_followups SET state='sending' WHERE account_id=? AND peer_id=? AND anchor_id=? AND state='pending'").run(row.account_id, row.peer_id, row.anchor_id);
        if (!reserved.changes) return;
        try {
          await opts.dm.send(row.account_id, row.peer_id, FOLLOWUP_TEXT);
          save(row.account_id, row.peer_id, null, 'assistant', FOLLOWUP_TEXT, 'sent');
          db.prepare("UPDATE customer_followups SET state='sent' WHERE account_id=? AND peer_id=? AND anchor_id=? AND state='sending'").run(row.account_id, row.peer_id, row.anchor_id);
          console.log(`客服超时跟进已发送：账号 ${row.account_id}，对方 ${row.peer_id}`);
        } catch {
          db.prepare("UPDATE customer_followups SET state='uncertain' WHERE account_id=? AND peer_id=? AND anchor_id=? AND state='sending'").run(row.account_id, row.peer_id, row.anchor_id);
          console.error(`客服超时跟进结果未确认：账号 ${row.account_id}，对方 ${row.peer_id}；请人工核查。`);
        }
      }).catch(() => {
        db.prepare("UPDATE customer_followups SET state='failed' WHERE account_id=? AND peer_id=? AND anchor_id=? AND state='pending'").run(row.account_id, row.peer_id, row.anchor_id);
        console.error('客服超时跟进处理失败，请检查日志。');
      }).finally(() => { queuedFollowups.delete(key); armTimer(); });
    }
    armTimer();
  }
  // 旧版本在每次回复后都会设置计时器；只保留第一条欢迎之后的待发引导。
  const oldPending = db.prepare("SELECT account_id,peer_id,anchor_id FROM customer_followups WHERE state='pending'").all() as Array<{account_id: string; peer_id: string; anchor_id: number}>;
  for (const item of oldPending) {
    const first = db.prepare("SELECT id FROM messages WHERE account_id=? AND peer_id=? AND role='assistant' AND state='sent' ORDER BY id LIMIT 1").get(item.account_id, item.peer_id) as { id: number } | undefined;
    const welcome = db.prepare("SELECT 1 FROM welcomes WHERE account_id=? AND peer_id=? AND state='sent'").get(item.account_id, item.peer_id);
    if (!welcome || Number(first?.id) !== Number(item.anchor_id) || hasIntroduced(item.account_id, item.peer_id)) {
      db.prepare("UPDATE customer_followups SET state='cancelled' WHERE account_id=? AND peer_id=? AND state='pending'").run(item.account_id, item.peer_id);
    }
  }
  // 未发送的任务重启后继续；发送中的结果保留供人工核查。
  armTimer();
  function startFollowupMonitoring() {
    if (monitoringStarted) return;
    // 事件流不补漏：进程关闭期间是否收到回复无法判断，保留待人工检查。
    const changed = db.prepare("UPDATE customer_followups SET state='unverified' WHERE state='pending'").run();
    if (changed.changes) console.warn(`有 ${changed.changes} 条超时跟进因离线无法确认回复，已暂停发送。`);
    monitoringStarted = true;
    armTimer();
  }
  function setConnection(isConnected: boolean) {
    if (!opts.requireConnection || stopped) return;
    if (connected && !isConnected) {
      const changed = db.prepare("UPDATE customer_followups SET state='unverified' WHERE state='pending'").run();
      if (changed.changes) console.warn(`事件流断开，${changed.changes} 条等待跟进因可能漏收回复而暂停。`);
    }
    connected = isConnected;
    armTimer();
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
    const incomingId = Number((db.prepare('SELECT id FROM messages WHERE event_key=?').get(eventKey) as { id: number }).id);
    cancelFollowup(account, peer);
    let phase = '解密或读取消息', sendStarted = false;
    chain = chain.then(async () => {
      const text = await getText(pin);
      if (!text) { db.prepare("UPDATE messages SET state='ignored' WHERE event_key=?").run(eventKey); return; }
      db.prepare("UPDATE messages SET text=?,state='processing' WHERE event_key=?").run(text, eventKey);
      if (latestUserId(account, peer) !== incomingId) { db.prepare("UPDATE messages SET state='merged' WHERE event_key=?").run(eventKey); return; }
      const messages = (db.prepare("SELECT role,text FROM (SELECT id,role,text FROM messages WHERE account_id=? AND peer_id=? AND text<>'' ORDER BY id DESC LIMIT 20) ORDER BY id").all(account, peer) as Array<{role: string; text: string}>);
      phase = '生成回复';
      const reply = await generateCustomerReply(opts.llm(), messages, hasIntroduced(account, peer) ? '引导后回复' : '第二条引导');
      if (latestUserId(account, peer) !== incomingId) { db.prepare("UPDATE messages SET state='merged' WHERE event_key=?").run(eventKey); return; }
      db.prepare("UPDATE messages SET state='sending' WHERE event_key=?").run(eventKey);
      phase = '发送回复'; sendStarted = true;
      await opts.dm.send(account, peer, reply);
      phase = '保存发送结果';
      save(account, peer, null, 'assistant', reply, 'sent');
      db.prepare("UPDATE messages SET state='done' WHERE event_key=?").run(eventKey);
      console.log(`客服回复已发送：账号 ${account}，对方 ${peer}`);
    }).catch((error) => {
      db.prepare('UPDATE messages SET state=? WHERE event_key=?').run(sendStarted ? 'uncertain' : 'failed', eventKey);
      console.error(`客服处理失败：账号 ${account}，对方 ${peer}；阶段：${phase}；${failureDetail(error)}${sendStarted ? '；发送结果需人工核实' : ''}。`);
    });
  }
  function reserveWelcome(account: string, peer: string) { return !!db.prepare("INSERT OR IGNORE INTO welcomes VALUES (?,?,'pending')").run(account, peer).changes; }
  function recordWelcome(account: string, peer: string, text: string, baseline = latestUserId(account, peer)) {
    const sent = save(account, peer, null, 'assistant', text, 'sent');
    db.prepare("UPDATE welcomes SET state='sent' WHERE account_id=? AND peer_id=?").run(account, peer);
    scheduleFollowup(account, peer, Number(sent.lastInsertRowid), baseline, text);
  }
  function queueWelcome(account: string, peer: string, username: string): boolean {
    if (stopped || !reserveWelcome(account, peer)) return false;
    chain = chain.then(async () => {
      const pin = pinFor(account);
      if (pin && latestUserId(account, peer)) { db.prepare("UPDATE welcomes SET state='skipped' WHERE account_id=? AND peer_id=?").run(account, peer); return; }
      const text = await generateDmReply(pin ? opts.llm() : null, { username }, pin ? '回关后的第一条私信' : '一次性欢迎');
      const baseline = latestUserId(account, peer);
      if (pin && baseline) { db.prepare("UPDATE welcomes SET state='skipped' WHERE account_id=? AND peer_id=?").run(account, peer); return; }
      const reserved = db.prepare("UPDATE welcomes SET state='sending' WHERE account_id=? AND peer_id=? AND state='pending'").run(account, peer);
      if (!reserved.changes) return;
      await opts.dm.send(account, peer, text);
      recordWelcome(account, peer, text, baseline);
      console.log(`回关欢迎已发送：账号 ${account}，对方 ${peer}`);
    }).catch(() => {
      db.prepare("UPDATE welcomes SET state=CASE WHEN state='sending' THEN 'uncertain' ELSE 'failed' END WHERE account_id=? AND peer_id=?").run(account, peer);
      console.error(`回关欢迎处理失败：账号 ${account}，对方 ${peer}；请人工核查。`);
    });
    return true;
  }
  return {
    hasPin(account: string) { return !!pinFor(account); },
    reserveWelcome, recordWelcome, queueWelcome, startFollowupMonitoring, setConnection,
    dm(event: DmEvent) { enqueue(event.accountId, event.senderId, `dm:${event.accountId}:${event.messageId}`, async () => event.text); },
    chat(event: ChatEvent) {
      const participants = event.conversationId.split(':');
      if (participants.length !== 2 || !participants.includes(event.accountId) || !participants.includes(event.senderId)) return;
      enqueue(event.accountId, event.senderId, `chat:${event.accountId}:${event.messageId}`, async pin => (await chatReader(event.accountId, pin)).decrypt(event));
    },
    async drain() { await chain; },
    async close() { stopped = true; if (timer) clearTimeout(timer); await chain; for (const state of readers.values()) state.reader?.close(); db.close(); },
  };
}
