import { randomUUID } from 'node:crypto';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { createHostChannelTransport } from '@getpaseo/client/node';
import type { connectDaemon } from '../daemon.ts';

export class DeadlineError extends Error {}

export async function deadline<T>(operation: Promise<T>, milliseconds: number, cancel = () => {}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          cancel();
          reject(new DeadlineError('来源主机响应超时'));
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface HostEntry {
  id: string;
  name: string;
  online: boolean;
}

/**
 * 跨主机转发通道（`core/hosts`）。
 *
 * 集中使用内部接口 `openHostRoute`、`createHostChannelTransport`、`invokePluginRpc`，
 * 供待办总览两台合看、跨主机操作转发、在线状态和停滞会话共用。
 */
export class HostRouter {
  protected origin: Awaited<ReturnType<typeof connectDaemon>>['client'];
  private remote = new Map<string, Promise<DaemonClient>>();
  protected stopped = false;

  constructor(origin: Awaited<ReturnType<typeof connectDaemon>>['client']) {
    this.origin = origin;
  }

  selfId(): string {
    return this.origin.getLastServerInfoMessage()?.serverId ?? 'local';
  }

  async hosts(): Promise<HostEntry[]> {
    const result = await this.origin.listHosts();
    return [
      { id: result.self.serverId, name: result.self.label || result.self.serverId, online: true },
      ...result.hosts
        .filter(host => host.serverId)
        .map(host => ({
          id: host.serverId!,
          name: host.label || host.serverId!,
          online: Boolean(host.enabled && host.status === 'online'),
        })),
    ];
  }

  private async client(hostId: string): Promise<DaemonClient> {
    if (this.stopped) throw new Error('插件已停止');
    let connection = this.remote.get(hostId);
    if (!connection) {
      connection = (async () => {
        const scope = randomUUID();
        const route = await deadline(this.origin.openHostRoute(hostId, scope), 20_000, () => this.origin.cancelHostRoute(scope));
        const client = new DaemonClient({
          url: 'ws://routed-host/ws',
          clientId: scope,
          transportFactory: createHostChannelTransport(this.origin, hostId, scope, route),
          reconnect: { enabled: false },
        });
        try {
          await deadline(client.connect(), 10_000);
          if (this.stopped) throw new Error('插件已停止');
          return client;
        } catch (error) {
          await client.close();
          throw error;
        }
      })();
      this.remote.set(hostId, connection);
    }
    return connection;
  }

  async withHost<T>(hostId: string, operation: (client: DaemonClient) => Promise<T>, keepOnTimeout = false): Promise<T> {
    const connection = this.client(hostId);
    let connected = false;
    try {
      const client = await connection;
      connected = true;
      return await operation(client);
    } catch (error) {
      if (connected && keepOnTimeout && error instanceof DeadlineError) throw error;
      const previous = this.remote.get(hostId);
      this.remote.delete(hostId);
      await previous?.then(client => client.close(), () => {});
      throw error;
    }
  }

  async invokePlugin(hostId: string, method: string, input: unknown, timeoutMs = 5000, onTimeout?: () => void, keepOnTimeout = false): Promise<unknown> {
    return this.withHost(
      hostId,
      client => deadline(client.invokePluginRpc('github-subscriptions', method, input), timeoutMs, onTimeout),
      keepOnTimeout,
    );
  }

  sameHost(left: string | null, right: string | null): boolean {
    const local = this.origin.getLastServerInfoMessage()?.serverId;
    return (left ?? local) === (right ?? local);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.remote.values()].map(connection => connection.then(client => client.close())));
    this.remote.clear();
  }
}
