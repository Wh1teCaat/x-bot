/** 比特浏览器本地 API；只允许本机地址，避免把窗口控制请求发往远端。 */
export class BitBrowserUnavailableError extends Error {
  constructor(cause: unknown) { super('无法连接比特浏览器本地 API，请确认客户端已登录且本地服务已启动', { cause }); this.name = 'BitBrowserUnavailableError'; }
}
/** 打开请求已被服务端拒绝或内部失败；服务端内容可能含凭证，不写入日志。 */
export class BitBrowserOpenError extends Error {
  constructor() { super('比特浏览器打开窗口失败（本地 API 返回失败；可能是比特云端连接、窗口状态或配置问题）'); this.name = 'BitBrowserOpenError'; }
}

export function localBitBrowserOrigin(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('比特浏览器本地 API 地址无效'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.port) {
    throw new Error('比特浏览器 API 必须是带端口的本机 HTTP 地址');
  }
  return url.origin;
}

function localWebSocket(input: unknown): string {
  if (typeof input !== 'string') throw new Error('比特浏览器未返回调试地址');
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('比特浏览器返回的调试地址无效'); }
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password || url.search || url.hash || !/^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
    throw new Error('比特浏览器返回的调试地址不是有效的本机浏览器端点');
  }
  return url.toString();
}

export class BitBrowserClient {
  private origin: string;
  private fetchImpl: typeof fetch;
  constructor(origin: string, fetchImpl: typeof fetch = fetch) {
    this.origin = localBitBrowserOrigin(origin);
    this.fetchImpl = fetchImpl;
  }
  private async post(path: '/health' | '/browser/open' | '/browser/close' | '/browser/detail' | '/browser/pids/alive' | '/browser/update', data: Record<string, unknown>) {
    let response: Response;
    // 启动窗口可能需要下载/初始化内核，接口可能在浏览器进程出现后才返回。
    const timeout = path === '/browser/open' ? 90_000 : 15_000;
    try { response = await this.fetchImpl(this.origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(timeout) }); }
    catch (error) { throw new BitBrowserUnavailableError(error); }
    if (!response.ok) {
      if (path === '/browser/open' && response.status >= 500) throw new BitBrowserOpenError();
      throw new Error(`比特浏览器本地 API 请求失败（HTTP ${response.status}）`);
    }
    const result = await response.json().catch(() => null) as { success?: boolean; data?: Record<string, unknown> } | null;
    // 服务端错误信息可能包含窗口信息或凭证，不写入日志。
    if (!result || (path === '/health' ? result.success === false : result.success !== true)) {
      if (path === '/browser/open') throw new BitBrowserOpenError();
      throw new Error(`比特浏览器本地 API 操作失败（${path}）`);
    }
    return result.data ?? {};
  }
  async health(): Promise<void> { await this.post('/health', {}); }
  async createIsolatedWindow(name: string): Promise<string> {
    if (!/^x-bot-pool-[a-z0-9-]{1,80}$/.test(name)) throw new Error('工作池窗口名称无效');
    const data = await this.post('/browser/update', { name, platform: 'https://x.com', platformIcon: 'x.com', url: '', remark: 'x-bot isolated pool', userName: '', password: '', proxyMethod: 2, proxyType: 'noproxy', browserFingerPrint: {}, syncCookies: false, syncIndexedDb: false, syncExtensions: false, syncUserExtensions: false, syncLocalStorage: false });
    if (typeof data.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.id)) throw new Error('比特浏览器未返回有效的窗口 ID');
    return data.id;
  }
  async isolated(id: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('比特浏览器窗口 ID 无效');
    const data = await this.post('/browser/detail', { id });
    return ['syncCookies', 'syncIndexedDb', 'syncExtensions', 'syncUserExtensions', 'syncLocalStorage'].every(key => data[key] === false);
  }
  async pid(id: string): Promise<number | null> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('比特浏览器窗口 ID 无效');
    const data = await this.post('/browser/pids/alive', { ids: [id] });
    return Number.isInteger(data[id]) && Number(data[id]) > 0 ? Number(data[id]) : null;
  }
  async isOpen(id: string): Promise<boolean> { return (await this.pid(id)) !== null; }
  async open(id: string, extensionPaths: string[] = [], options: { headless?: boolean } = {}): Promise<{ ws: string; coreVersion: string | null }> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('比特浏览器窗口 ID 无效');
    if (extensionPaths.some(path => !path.startsWith('/') || path.includes(',') || /[\r\n\0]/.test(path))) throw new Error('扩展路径无效');
    const args = [...(extensionPaths.length ? [`--load-extension=${extensionPaths.join(',')}`] : []), ...(options.headless ? ['--headless'] : [])];
    const data = await this.post('/browser/open', { id, ...(args.length ? { args } : {}) });
    return { ws: localWebSocket(data.ws), coreVersion: typeof data.coreVersion === 'string' ? data.coreVersion : null };
  }
  async close(id: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('比特浏览器窗口 ID 无效');
    await this.post('/browser/close', { id });
  }
}
