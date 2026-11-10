import { setTimeout as delay } from 'node:timers/promises';

/** 启动失败后每隔 delayMs 重试，直到成功或信号取消。 */
export async function startWithRetry(start: () => Promise<void>, options: { delayMs: number; signal: AbortSignal; onError: (error: unknown) => void }): Promise<void> {
  while (!options.signal.aborted) {
    try { await start(); return; }
    catch (error) {
      if (options.signal.aborted) return;
      options.onError(error);
      try { await delay(options.delayMs, undefined, { signal: options.signal }); } catch { return; }
    }
  }
}
