import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import type { BrowserContext, Response } from 'playwright';
import { ResilienceStore } from '../loop/resilience.ts';

/** 与采集调度器共享 X 页面熔断，阻止之后的浏览器动作。 */
export class XPageCircuit {
  private db: DatabaseSync;
  private resilience: ResilienceStore;
  private failures = 0;
  private context?: BrowserContext;
  private listener: (response: Response) => void;
  constructor(path = '.data/loop.sqlite') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=10000');
    this.resilience = new ResilienceStore(this.db);
    this.listener = response => {
      try {
        const host = new URL(response.url()).hostname.toLowerCase();
        if (!(host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com'))) return;
        if (response.status() === 429) this.resilience.open('x', 'X 页面返回 HTTP 429');
        else if (response.status() >= 500) { if (++this.failures >= 3) this.resilience.open('x', 'X 页面请求连续出现服务端错误'); }
        else if (response.status() < 400) this.failures = 0;
      } catch { /* 与页面状态无关的请求忽略 */ }
    };
  }
  attach(context: BrowserContext) { this.context = context; context.on('response', this.listener); }
  isBlocked() { const state = this.resilience.circuit('x')?.state; return state === 'open' || state === 'half_open'; }
  guard() {
    if (this.isBlocked()) throw new Error('X 页面熔断中，停止页面操作并等待恢复');
  }
  close() { if (this.context) this.context.off('response', this.listener); this.db.close(); }
}
