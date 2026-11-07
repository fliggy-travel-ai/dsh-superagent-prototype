import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPaseoApi } from '@getpaseo/client';
import { createHostClient } from '@getpaseo/client/node';

export async function connectDaemon(home: string, signal: AbortSignal = new AbortController().signal) {
  const deadline = Date.now() + 60_000;
  let detail = '本机守护进程连接尚未就绪';
  while (!signal.aborted && Date.now() < deadline) {
    let client: ReturnType<typeof createHostClient> | null = null;
    try {
      const lock = JSON.parse(await readFile(join(home, 'paseo.pid'), 'utf8')) as { listen?: unknown };
      if (typeof lock.listen !== 'string') {
        detail = '本机守护进程尚未写入监听地址';
      } else {
        client = createHostClient(lock.listen, {
          clientId: `github-subscriptions-${randomUUID()}`, clientType: 'cli',
          localCredential: async () => (await readFile(join(home, 'local-credential'), 'utf8')).trim() || undefined,
          reconnect: { enabled: true },
        });
        const active = client;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let abort = () => {};
        try {
          await Promise.race([active.connect(), new Promise<never>((_resolve, reject) => {
            abort = () => reject(new Error('插件已停止'));
            signal.addEventListener('abort', abort, { once: true });
            timer = setTimeout(() => reject(new Error('连接本机守护进程超时')), 5000);
            if (signal.aborted) abort();
          })]);
        } finally {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
        }
        if (signal.aborted) throw new Error('插件已停止');
        return { paseo: createPaseoApi(active), close: () => active.close() };
      }
    } catch {
      detail = '无法读取本机连接信息或连接本机守护进程失败';
      await client?.close();
    }
    if (!signal.aborted) await delay(500, undefined, { signal }).catch(() => {});
  }
  throw new Error(signal.aborted ? '插件已停止' : `${detail}，等待 60 秒后仍未恢复；下次操作会重试`);
}
