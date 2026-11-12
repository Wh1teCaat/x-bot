/** 按账号保存工作实例的状态；就绪后只接受串行任务。 */
export type PoolState = 'awaiting_login' | 'checking' | 'running' | 'idle' | 'stopped';

/** 单个池位绑定一个账号，用户确认登录前不检查或操作浏览器。 */
export class AccountPoolSlot {
  state: PoolState = 'awaiting_login';
  lastError: string | null = null;
  private readonly check: () => Promise<void>;
  private readonly runJob: () => Promise<void>;
  private readonly report: (message: string) => void;

  constructor({ check, run, report }: { check: () => Promise<void>; run: () => Promise<void>; report: (message: string) => void }) {
    this.check = check; this.runJob = run; this.report = report;
  }

  /** 用户确认登录后验证账号和插件，再执行当前任务。 */
  ready(): string {
    if (this.state !== 'awaiting_login') return `当前状态：${this.state}`;
    this.launch(); return '开始验证账号及插件。';
  }

  /** 已就绪的账号实例可直接处理新任务；首次使用仍需人工确认。 */
  run(): string {
    if (this.state === 'awaiting_login') return '请先登录并执行 account:ready。';
    if (this.state !== 'idle') return `当前状态：${this.state}，未启动新任务。`;
    this.launch(); return '已复用空闲实例，开始验证并执行。';
  }

  /** 停止后不再接收任务；浏览器和任务进程由调用者关闭。 */
  stop() { this.state = 'stopped'; }

  private launch() {
    this.state = 'checking';
    this.lastError = null;
    void (async () => {
      try {
        await this.check();
        if (this.state === 'stopped') return;
        this.state = 'running';
        await this.runJob();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.report(this.lastError);
        if (this.state === 'checking') { this.state = 'awaiting_login'; return; }
      }
      if (this.state !== 'stopped') this.state = 'idle';
    })();
  }
}
