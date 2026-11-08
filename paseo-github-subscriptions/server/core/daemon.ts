import { connectDaemon } from '../daemon.ts';

export type DaemonConnection = Awaited<ReturnType<typeof connectDaemon>>;

/**
 * 全部模块共用的本机守护进程连接。
 *
 * 守护进程启动初期 `paseo.pid` 还没有监听地址，所以连接函数要重试（connectDaemon 最多等 60 秒）。
 * 连接失败后清掉缓存，下一次调用重新连接。用法：`const { paseo, client } = await daemon.ready();`
 */
export class SharedDaemon<Connection extends { close(): Promise<void> } = DaemonConnection> {
  private readonly home: string;
  private readonly connect: (home: string, signal: AbortSignal) => Promise<Connection>;
  private readonly controller = new AbortController();
  private connecting: Promise<Connection> | null = null;
  private connection: Connection | null = null;
  private stopped = false;

  constructor(home: string, connect: (home: string, signal: AbortSignal) => Promise<Connection> = connectDaemon as never) {
    this.home = home;
    this.connect = connect;
  }

  ready(): Promise<Connection> {
    if (this.stopped) return Promise.reject(new Error('插件已停止'));
    this.connecting ??= this.connect(this.home, this.controller.signal).then(async value => {
      if (this.stopped) { await value.close(); throw new Error('插件已停止'); }
      this.connection = value;
      return value;
    }).catch(error => { this.connecting = null; throw error; });
    return this.connecting;
  }

  /** 已建立的连接；还没连上时为 null。 */
  current(): Connection | null {
    return this.connection;
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.controller.abort();
    try { await this.connecting; } catch {}
    await this.connection?.close();
    this.connection = null;
  }
}
