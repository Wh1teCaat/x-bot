/** 依据稳定标识生成确定性的浏览器指纹，使不同账号的常见指纹信号各不相同。 */
import { createHash } from 'node:crypto';

export type BrowserFingerprint = {
  locale: string;
  timezoneId: string;
  viewport: { width: number; height: number };
  screen: { width: number; height: number };
  colorScheme: 'light' | 'dark';
  acceptLanguage: string;
};

const LOCALES = [
  { locale: 'en-US', lang: 'en-US,en;q=0.9' },
  { locale: 'en-GB', lang: 'en-GB,en;q=0.9' },
  { locale: 'en-CA', lang: 'en-CA,en;q=0.9' },
  { locale: 'zh-CN', lang: 'zh-CN,zh;q=0.9,en;q=0.8' },
  { locale: 'zh-TW', lang: 'zh-TW,zh;q=0.9,en;q=0.8' },
  { locale: 'ja-JP', lang: 'ja-JP,ja;q=0.9,en;q=0.8' },
  { locale: 'ko-KR', lang: 'ko-KR,ko;q=0.9,en;q=0.8' },
  { locale: 'ar-SA', lang: 'ar-SA,ar;q=0.9,en;q=0.8' },
];

const TIMEZONES = [
  'America/New_York', 'America/Los_Angeles', 'America/Chicago', 'America/Toronto',
  'Europe/London', 'Europe/Berlin', 'Europe/Paris',
  'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore', 'Asia/Riyadh',
];

const RESOLUTIONS = [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 1280, height: 800 },
  { width: 1512, height: 982 },
  { width: 1728, height: 1117 },
];

function hashSeed(value: string): number {
  return createHash('sha256').update(value).digest().readUInt32LE(0);
}

/** 确定性伪随机数发生器，保证同一标识每次得到相同结果。 */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 生成账号指纹；同一 seed 结果稳定，不同 seed 通常不同。 */
export function fingerprintFor(seed: string): BrowserFingerprint {
  const rnd = mulberry32(hashSeed(seed));
  const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
  const locale = pick(LOCALES);
  const res = pick(RESOLUTIONS);
  return {
    locale: locale.locale,
    timezoneId: pick(TIMEZONES),
    viewport: res,
    screen: { width: res.width, height: res.height + 87 },
    colorScheme: rnd() < 0.5 ? 'light' : 'dark',
    acceptLanguage: locale.lang,
  };
}
