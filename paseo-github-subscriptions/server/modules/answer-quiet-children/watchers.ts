export interface WatchHandle { ready: Promise<unknown>; stop(): void }

/**
 * 子会话时间线订阅的登记簿：每个会话最多一个订阅；会话归档、关闭或不再是子会话时释放；
 * 订阅建立中就被释放的，立刻取消。
 */
export class TimelineWatchers {
  private readonly entries = new Map<string, { released: boolean; stop?: () => void }>();

  has(id: string) { return this.entries.has(id); }
  ids() { return [...this.entries.keys()]; }

  async watch(id: string, open: () => WatchHandle): Promise<void> {
    if (this.entries.has(id)) return;
    const entry: { released: boolean; stop?: () => void } = { released: false };
    this.entries.set(id, entry);
    let handle: WatchHandle;
    try { handle = open(); } catch (error) { this.entries.delete(id); throw error; }
    entry.stop = () => handle.stop();
    try { await handle.ready; }
    catch (error) { if (this.entries.get(id) === entry) this.entries.delete(id); handle.stop(); throw error; }
  }

  release(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    entry.released = true;
    entry.stop?.();
  }

  releaseAll() { for (const id of this.ids()) this.release(id); }
}
