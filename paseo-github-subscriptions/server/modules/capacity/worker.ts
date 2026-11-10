/** 合并重复触发，串行执行耗时迁移；调用方不等待工作结束。 */
export class MigrationWorker {
  private current: Promise<void> | null = null;
  private pending = false;
  private stopped = false;
  private readonly run: () => Promise<void>;
  constructor(run: () => Promise<void>) { this.run = run; }
  request() {
    if (this.stopped) return;
    if (this.current) { this.pending = true; return; }
    this.current = this.run().catch(() => {}).finally(() => {
      this.current = null;
      if (this.pending && !this.stopped) { this.pending = false; this.request(); }
    });
  }
  async stop() { this.stopped = true; await this.current; }
}
