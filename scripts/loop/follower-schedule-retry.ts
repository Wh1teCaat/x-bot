/** 仅本地浏览器 API 在采集启动之前不可达时自动重试。 */
import { BitBrowserOpenError, BitBrowserUnavailableError } from '../browser/bitbrowser-client.ts';
export const BIT_BROWSER_PRESTART_UNAVAILABLE = 75;
export const FOLLOWER_BROWSER_RETRY_MS = 5 * 60_000;
export const FOLLOWER_BROWSER_MAX_RETRIES = 3;
export function nextFollowerBrowserRetry(previousFailures: number, now: number) {
  const failures = previousFailures + 1;
  return { failures, blocked: failures > FOLLOWER_BROWSER_MAX_RETRIES, retryAt: now + FOLLOWER_BROWSER_RETRY_MS };
}
export function followerBatchFailure(code: number): 'retry-browser' | 'blocked' | 'none' {
  return code === 0 ? 'none' : code === BIT_BROWSER_PRESTART_UNAVAILABLE ? 'retry-browser' : 'blocked';
}
export function browserFailureExitCode(error: unknown, workerStarted: boolean): number {
  return !workerStarted && (error instanceof BitBrowserUnavailableError || error instanceof BitBrowserOpenError) ? BIT_BROWSER_PRESTART_UNAVAILABLE : 1;
}
