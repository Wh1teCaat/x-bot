/** 校验单轮任务参数；账号、浏览器端口和运行状态由调用者显式传递。 */
export type LoopArguments = {
  resumeId?: string;
  accountId?: string;
  username?: string;
  cdpPort?: number;
  runId?: string;
  followProbe: boolean;
  /** 指定要采集回复的博主；缺省时使用该授权账号的 clone 来源。 */
  blogger?: string;
  /** 可选语言筛选；目前仅支持阿拉伯语 ar。 */
  language?: "ar";
  /** 可选模型评估；缺省只使用固定关注/粉丝规则。 */
  evaluate: boolean;
  /** 跳过关注前人工确认（y/n）。 */
  yes: boolean;
  /** 只处理指定帖子（镜像延迟回复爬取使用）。 */
  postUrl?: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const handle = /^[A-Za-z0-9_]{1,15}$/;
const statusUrl = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,19})(?:[?#].*)?$/i;

/** 解析公开参数；内部运行参数仅允许由调度器传给子进程。 */
export function parseLoopArguments(args: string[], internal = false): LoopArguments {
  const result: LoopArguments = { followProbe: false, evaluate: false, yes: false };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (seen.has(key)) throw new Error('参数不能重复');
    seen.add(key);
    if (key === '--evaluate') { result.evaluate = true; continue; }
    if (key === '--yes') { result.yes = true; continue; }
    if (key === '--follow-probe' && internal) { result.followProbe = true; continue; }
    const value = args[++i];
    if (!value) throw new Error('参数缺少值');
    if (key === '--resume' && uuid.test(value)) result.resumeId = value;
    else if (key === '--run-id' && internal && uuid.test(value)) result.runId = value;
    else if (key === '--account-id' && /^\d{1,19}$/.test(value)) result.accountId = value;
    else if (key === '--username' && handle.test(value)) result.username = value;
    else if (key === '--blogger') {
      const name = value.replace(/^@/, '');
      if (!handle.test(name)) throw new Error('博主用户名必须是 1–15 位英文字母、数字或下划线');
      result.blogger = name;
    }
    else if (key === '--language') {
      if (value !== 'ar') throw new Error('目前仅支持阿拉伯语筛选（--language ar）');
      result.language = 'ar';
    }
    else if (key === '--post') {
      const match = statusUrl.exec(value);
      if (!match) throw new Error('--post 必须是 X 帖子链接');
      result.postUrl = `https://x.com/${match[1]}/status/${match[2]}`;
    }
    else if (key === '--cdp-port' && /^\d{1,5}$/.test(value) && +value > 0 && +value <= 65535) result.cdpPort = +value;
    else throw new Error(`无效参数 ${key}`);
  }
  if (result.resumeId && result.runId) throw new Error('不能同时指定新任务 ID 和恢复任务 ID');
  if (result.username && !result.accountId) throw new Error('浏览器用户名必须绑定授权账号 ID');
  if (result.followProbe && !result.resumeId) throw new Error('半开探测只能恢复已有任务');
  return result;
}
