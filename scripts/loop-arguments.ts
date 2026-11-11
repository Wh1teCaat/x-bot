/** 校验单轮任务参数；账号、浏览器端口和运行状态由调用者显式传递。 */
export type LoopArguments = { resumeId?: string; accountId?: string; username?: string; cdpPort?: number; runId?: string; followProbe: boolean };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 解析公开参数；内部运行参数仅允许由调度器传给子进程。 */
export function parseLoopArguments(args: string[], internal = false): LoopArguments {
  const result: LoopArguments = { followProbe: false };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (seen.has(key)) throw new Error('参数不能重复');
    seen.add(key);
    if (key === '--follow-probe' && internal) { result.followProbe = true; continue; }
    const value = args[++i];
    if (!value) throw new Error('参数缺少值');
    if (key === '--resume' && uuid.test(value)) result.resumeId = value;
    else if (key === '--run-id' && internal && uuid.test(value)) result.runId = value;
    else if (key === '--account-id' && /^\d{1,19}$/.test(value)) result.accountId = value;
    else if (key === '--username' && /^[A-Za-z0-9_]{1,15}$/.test(value)) result.username = value;
    else if (key === '--cdp-port' && /^\d{1,5}$/.test(value) && +value > 0 && +value <= 65535) result.cdpPort = +value;
    else throw new Error(`无效参数 ${key}`);
  }
  if (result.resumeId && result.runId) throw new Error('不能同时指定新任务 ID 和恢复任务 ID');
  if (result.username && !result.accountId) throw new Error('浏览器用户名必须绑定授权账号 ID');
  if (result.followProbe && !result.resumeId) throw new Error('半开探测只能恢复已有任务');
  return result;
}
