export interface ClearerOptions {
  clearAgents(ids: string[]): Promise<unknown>;
  clearWorkspaces(ids: string[]): Promise<unknown>;
  log(line: string): void;
  signal: AbortSignal;
  /** 工作区每批的数量，默认 20。会话始终逐个清除。 */
  batchSize?: number;
}

/**
 * 启动时可能有几百个会话要清除。排队后逐批发送，避免压垮守护进程：
 * 工作区每批最多 20 个，会话一次一个。同一个会话或工作区在队列中只保留一份。
 */
export class AttentionClearer {
  private readonly options: ClearerOptions;
  private readonly agents = new Set<string>();
  private readonly workspaces = new Set<string>();
  private flushing: Promise<void> | null = null;

  constructor(options: ClearerOptions) { this.options = options; }

  enqueue(scope: 'agent' | 'workspace', agentId: string, workspaceId: string | null | undefined) {
    if (scope === 'workspace' && workspaceId) this.workspaces.add(workspaceId);
    else this.agents.add(agentId);
    // 同一轮同步入队的项目合成一批：等微任务再开始发送。
    queueMicrotask(() => { void this.flush(); });
  }

  /** 队列清空后返回。测试用。 */
  async idle() { await this.flush(); }

  private flush(): Promise<void> {
    this.flushing ??= (async () => {
      try {
        const size = this.options.batchSize ?? 20;
        while ((this.agents.size > 0 || this.workspaces.size > 0) && !this.options.signal.aborted) {
          const byWorkspace = this.workspaces.size > 0;
          const queue = byWorkspace ? this.workspaces : this.agents;
          const batch = [...queue].slice(0, byWorkspace ? size : 1);
          for (const id of batch) queue.delete(id);
          const unit = byWorkspace ? '工作区' : '会话';
          try {
            await (byWorkspace ? this.options.clearWorkspaces(batch) : this.options.clearAgents(batch));
            this.options.log(`已清除待查看：${batch.length} 个${unit}`);
          } catch (error) {
            this.options.log(`清除待查看失败（${batch.length} 个${unit}）：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } finally { this.flushing = null; }
    })();
    return this.flushing;
  }
}
