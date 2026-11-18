/** Non-secret runtime settings; environment overrides are reserved for explicit process/CLI overrides. */
import 'dotenv/config';
import { readFileSync, existsSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parse, stringify } from 'smol-toml';
export const configSchema: Record<string, { default: string | number | boolean; label: string; min?: number; max?: number }> = {
  "PORT": {
    "default": 3000,
    "label": "服务端口",
    "min": 1,
    "max": 65535
  },
  "X_AUTO_START_LOOP": {
    "default": false,
    "label": "授权后自动启动旧版后台会话"
  },
  "MIRROR_INTERVAL_MS": {
    "default": 60000,
    "label": "镜像轮询间隔（毫秒）",
    "min": 5000,
    "max": 86400000
  },
  "MIRROR_POST_GAP_MIN_MS": {
    "default": 5000,
    "label": "发帖最小间隔（毫秒）",
    "min": 0,
    "max": 86400000
  },
  "MIRROR_POST_GAP_MAX_MS": {
    "default": 10000,
    "label": "发帖最大间隔（毫秒）",
    "min": 0,
    "max": 86400000
  },
  "MIRROR_POLL_JITTER_MS": {
    "default": 12000,
    "label": "轮询随机抖动（毫秒）",
    "min": 0,
    "max": 86400000
  },
  "MIRROR_REQUEST_JITTER_MS": {
    "default": 800,
    "label": "API 请求随机抖动（毫秒）",
    "min": 0,
    "max": 60000
  },
  "MIRROR_REPLY_DELAY_MS": {
    "default": 18000000,
    "label": "新帖回复采集延迟（毫秒）",
    "min": 0,
    "max": 604800000
  },
  "MIRROR_REPLY_SCHEDULER_MS": {
    "default": 60000,
    "label": "回复调度检查间隔（毫秒）",
    "min": 1000,
    "max": 86400000
  },
  "MIRROR_REPLY_RETRY_MS": {
    "default": 600000,
    "label": "回复采集重试间隔（毫秒）",
    "min": 1000,
    "max": 86400000
  },
  "MIRROR_REPLY_AUTO_YES": {
    "default": false,
    "label": "延迟采集任务自动确认"
  },
  "CLONE_TARGET_MIN_REPLIES": {
    "default": 50,
    "label": "目标帖子最少回复数",
    "min": 1,
    "max": 1000000
  },
  "CLONE_TARGET_MIN_FOLLOWERS": {
    "default": 1000,
    "label": "目标最少粉丝数",
    "min": 1,
    "max": 1000000000
  },
  "CLONE_TARGET_REQUIRED_POSTS": {
    "default": 2,
    "label": "目标符合要求的帖子数",
    "min": 1,
    "max": 3
  },
  "CLONE_TARGET_MAX_CANDIDATES": {
    "default": 40,
    "label": "搜索候选数量上限",
    "min": 1,
    "max": 10000
  },
  "FASHION_SEARCH_QUERIES": {
    "default": "fashion,fashion blogger,fashion influencer,ootd,street style",
    "label": "博主搜索关键词（逗号分隔）"
  },
  "X_BROWSER_EXECUTABLE": {
    "default": "",
    "label": "Chrome 可执行文件（空值使用默认路径）"
  },
  "PROFILE_COPY_CHROME": {
    "default": "",
    "label": "资料复制 Chrome 路径"
  },
  "X_COOKIE_FILE": {
    "default": "",
    "label": "指定 Cookie 文件（空值按账号选择）"
  },
  "X_FOLLOW_ACCOUNT_ID": {
    "default": "",
    "label": "默认关注账号 ID"
  },
  "X_ACTIVITY_ACCOUNT_ID": {
    "default": "",
    "label": "默认关注事件账号 ID"
  },
  "X_EXPORTER24_EXTENSION_ID": {
    "default": "ebcejikneofoobengkjlojmbohgjacne",
    "label": "exporter24 扩展 ID"
  },
  "X_PROFILE_TEMPLATE": {
    "default": "",
    "label": "浏览器模板目录"
  },
  "X_PROFILE_TEMPLATE_SOURCE": {
    "default": "",
    "label": "浏览器模板来源目录"
  },
  "X_BOT_CDP_PORT": {
    "default": 9333,
    "label": "浏览器调试端口",
    "min": 1,
    "max": 65535
  },
  "FOLLOWER_EXPORT_TIMEOUT_MS": {
    "default": 600000,
    "label": "粉丝导出超时（毫秒）",
    "min": 30000,
    "max": 86400000
  }
};
export const configPath = process.env.NODE_ENV === 'test' && process.env.X_TEST_DATA_DIR ? resolve(process.env.X_TEST_DATA_DIR, 'config.toml') : resolve('config.toml');
export function validateConfig(input: unknown): Record<string, string | number | boolean> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('配置必须是对象');
  const result = Object.fromEntries(Object.entries(configSchema).map(([key, rule]) => [key, rule.default]));
  for (const [key, value] of Object.entries(input)) {
    const rule = configSchema[key];
    if (!rule) throw new Error(`不支持的运行配置：${key}`);
    if (typeof value !== typeof rule.default) throw new Error(`${key} 类型错误`);
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < rule.min! || value > rule.max!)) throw new Error(`${key} 超出范围 ${rule.min}–${rule.max}`);
    if (typeof value === 'string' && (value.length > 4096 || /[\r\n\0]/.test(value))) throw new Error(`${key} 内容无效`);
    if (['X_FOLLOW_ACCOUNT_ID', 'X_ACTIVITY_ACCOUNT_ID'].includes(key) && value && !/^\d{1,19}$/.test(String(value))) throw new Error(`${key} 必须为数字账号 ID`);
    result[key] = value;
  }
  if (Number(result.MIRROR_POST_GAP_MAX_MS) < Number(result.MIRROR_POST_GAP_MIN_MS)) throw new Error('最大发帖间隔不能小于最小间隔');
  return result;
}
export function readRuntimeConfig(path = configPath) {
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const parsed = parse(raw);
  if (Object.keys(parsed).some(key => key !== 'runtime')) throw new Error('配置仅支持 [runtime] 节');
  return { values: validateConfig(parsed.runtime ?? {}), revision: createHash('sha256').update(raw).digest('hex') };
}
export function saveRuntimeConfig(values: unknown, revision: string, path = configPath) {
  const checked = validateConfig(values);
  if (readRuntimeConfig(path).revision !== revision) throw new Error('配置已被其他操作修改，请重新加载后保存');
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, '# 非密钥运行配置；修改后重启服务及任务生效。\n' + stringify({ runtime: checked }), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return readRuntimeConfig(path);
}
const initial = readRuntimeConfig();
for (const [key, value] of Object.entries(initial.values)) {
  if (process.env[key] === undefined && value !== '') process.env[key] = String(value);
}
