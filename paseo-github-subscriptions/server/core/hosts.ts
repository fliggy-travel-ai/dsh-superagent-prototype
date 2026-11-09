import { randomUUID } from 'node:crypto';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { createHostChannelTransport } from '@getpaseo/client/node';
import type { connectDaemon } from '../daemon.ts';

export class DeadlineError extends Error {}

function isTransportFailure(error: unknown, client: { isConnected?: boolean } | null): boolean {
  if (client && client.isConnected === false) return true;
  if (error && typeof error === 'object') {
    const rec = error as { code?: unknown; serverId?: unknown };
    if (rec.code === 'host_offline' || typeof rec.serverId === 'string') return true;
  }
  const msg = error instanceof Error ? error.message : String(error ?? '');
  return /(?:transport|connection|disconnected|daemon client is closed|daemon client is disposed|not connected|socket|route closed|host .* is offline)/i.test(
    msg,
  );
}

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
  private pendingCancel = new Map<string, () => void>();
  private cachedSelf: HostEntry | null = null;
  protected stopped = false;

  constructor(origin: Awaited<ReturnType<typeof connectDaemon>>['client']) {
    this.origin = origin;
  }

  selfId(): string {
    return this.cachedSelf?.id ?? this.origin.getLastServerInfoMessage()?.serverId ?? 'local';
  }

  async selfHost(fallbackName = '本机'): Promise<HostEntry> {
    if (this.cachedSelf) return this.cachedSelf;
    try {
      const list = await this.hosts();
      if (this.cachedSelf) return this.cachedSelf;
      if (list[0]) return list[0];
    } catch {
      // listHosts 失败时回退到连接握手信息中的固定 serverId
    }
    const serverId = this.origin.getLastServerInfoMessage()?.serverId;
    if (serverId) {
      const entry: HostEntry = { id: serverId, name: fallbackName || serverId, online: true };
      this.cachedSelf = entry;
      return entry;
    }
    return { id: 'local', name: fallbackName, online: true };
  }

  async hosts(): Promise<HostEntry[]> {
    const result = await this.origin.listHosts();
    const selfEntry: HostEntry = {
      id: result.self.serverId,
      name: result.self.label || result.self.serverId,
      online: true,
    };
    this.cachedSelf = selfEntry;
    return [
      selfEntry,
      ...result.hosts
        .filter(host => host.serverId && host.serverId !== selfEntry.id)
        .map(host => ({
          id: host.serverId!,
          name: host.label || host.serverId!,
          online: Boolean(host.enabled && host.status === 'online'),
        })),
    ];
  }

  private client(hostId: string): Promise<DaemonClient> {
    if (this.stopped) return Promise.reject(new Error('插件已停止'));
    let connection = this.remote.get(hostId);
    if (!connection) {
      const created = (async () => {
        const scope = randomUUID();
        let rejectRoute: ((err: Error) => void) | undefined;
        const routeAbort = new Promise<never>((_resolve, reject) => {
          rejectRoute = reject;
        });
        this.pendingCancel.set(hostId, () => {
          this.origin.cancelHostRoute(scope);
          rejectRoute?.(new DeadlineError('来源主机响应超时'));
        });
        try {
          const route = await deadline(
            Promise.race([this.origin.openHostRoute(hostId, scope), routeAbort]),
            20_000,
            () => this.origin.cancelHostRoute(scope),
          );
          const client = new DaemonClient({
            url: 'ws://routed-host/ws',
            clientId: scope,
            transportFactory: createHostChannelTransport(this.origin, hostId, scope, route),
            reconnect: { enabled: false },
          });
          try {
            await deadline(Promise.race([client.connect(), routeAbort]), 10_000);
            if (this.stopped) throw new Error('插件已停止');
            return client;
          } catch (error) {
            await client.close();
            throw error;
          }
        } finally {
          this.pendingCancel.delete(hostId);
        }
      })();
      void created.catch(() => {
        if (this.remote.get(hostId) === created) {
          this.remote.delete(hostId);
        }
      });
      this.remote.set(hostId, created);
      connection = created;
    }
    return connection;
  }

  async withHost<T>(hostId: string, operation: (client: DaemonClient) => Promise<T>, keepOnTimeout = true): Promise<T> {
    const connection = this.client(hostId);
    let connected = false;
    let activeClient: DaemonClient | null = null;
    try {
      const client = await connection;
      connected = true;
      activeClient = client;
      return await operation(client);
    } catch (error) {
      if (connected && keepOnTimeout && error instanceof DeadlineError) throw error;
      if (!connected && error instanceof DeadlineError) {
        this.pendingCancel.get(hostId)?.();
        throw error;
      }
      if (connected && !(error instanceof DeadlineError) && !isTransportFailure(error, activeClient)) {
        throw error;
      }
      const previous = this.remote.get(hostId);
      if (previous === connection) {
        this.remote.delete(hostId);
        await previous.then(client => client.close(), () => {});
      }
      throw error;
    }
  }

  async invokePlugin(hostId: string, method: string, input: unknown, timeoutMs = 5000, onTimeout?: () => void, keepOnTimeout = true): Promise<unknown> {
    let connected = false;
    let activeClient: DaemonClient | null = null;
    const connection = this.client(hostId);
    try {
      return await deadline(
        (async () => {
          const client = await connection;
          connected = true;
          activeClient = client;
          return await client.invokePluginRpc('github-subscriptions', method, input);
        })(),
        timeoutMs,
        () => {
          if (!connected) this.pendingCancel.get(hostId)?.();
          onTimeout?.();
        },
      );
    } catch (error) {
      if (connected && keepOnTimeout && error instanceof DeadlineError) throw error;
      if (!connected && error instanceof DeadlineError) throw error;
      if (connected && !(error instanceof DeadlineError) && !isTransportFailure(error, activeClient)) {
        throw error;
      }
      const previous = this.remote.get(hostId);
      if (previous === connection) {
        this.remote.delete(hostId);
        await previous.then(client => client.close(), () => {});
      }
      throw error;
    }
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
