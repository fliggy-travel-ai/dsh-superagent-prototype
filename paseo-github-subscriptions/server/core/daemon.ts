import { connectDaemon } from '../daemon.ts';

export type DaemonConnection = Awaited<ReturnType<typeof connectDaemon>>;

/**
 * 全部模块共用的本机守护进程连接。
 *
 * 守护进程启动初期 `paseo.pid` 还没有监听地址，所以连接函数要重试（connectDaemon 最多等 60 秒）。
 * 连接失败后清掉缓存，下一次调用重新连接。用法：`const { paseo, client } = await daemon.ready();`
 *
 * 插件停止分两步：先 `stopConnecting()` 结束未完成的连接尝试，模块和运行时停止时仍可用已建立的连接；最后 `close()` 关闭连接。
 */
export class SharedDaemon<Connection extends { close(): Promise<void> } = DaemonConnection> {
  private readonly home: string;
  private readonly connect: (home: string, signal: AbortSignal) => Promise<Connection>;
  private readonly controller = new AbortController();
  private connecting: Promise<Connection> | null = null;
  private connection: Connection | null = null;
  private stopped = false;
  private stopping = false;

  constructor(home: string, connect: (home: string, signal: AbortSignal) => Promise<Connection> = connectDaemon as never) {
    this.home = home;
    this.connect = connect;
  }

  ready(): Promise<Connection> {
    if (this.stopped || (this.stopping && !this.connection)) return Promise.reject(new Error('插件已停止'));
    this.connecting ??= this.connect(this.home, this.controller.signal).then(async value => {
      if (this.stopping) { await value.close(); throw new Error('插件已停止'); }
      this.connection = value;
      return value;
    }).catch(error => { this.connecting = null; throw error; });
    return this.connecting;
  }

  /** 已建立的连接；还没连上时为 null。 */
  current(): Connection | null {
    return this.connection;
  }

  /** 结束未完成的连接尝试，之后不再新建连接；已建立的连接保留到 `close()`。 */
  stopConnecting(): void {
    this.stopping = true;
    this.controller.abort();
  }

  async close(): Promise<void> {
    this.stopping = true;
    this.stopped = true;
    this.controller.abort();
    try { await this.connecting; } catch {}
    await this.connection?.close();
    this.connection = null;
  }
}
