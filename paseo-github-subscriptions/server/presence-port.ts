import { randomUUID } from 'node:crypto';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { createHostChannelTransport } from '@getpaseo/client/node';
import type { connectDaemon } from './daemon.ts';
import type { PresencePort, QuestionAgent } from './presence.ts';
import { PresenceObservationSchema } from '../shared/presence.ts';
import { readGuardPresence } from './guard-presence.ts';
import { GuardSpeech } from './speech.ts';
import { SpeechResultSchema } from '../shared/speech.ts';
import { listBluetoothTargets, saveBluetoothTarget } from './bluetooth-target.ts';
import { BluetoothConfigSchema, BluetoothSnapshotSchema, type BluetoothTarget } from '../shared/bluetooth.ts';

class DeadlineError extends Error {}
async function deadline<T>(operation: Promise<T>, milliseconds: number, cancel = () => {}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { cancel(); reject(new DeadlineError('来源主机响应超时')); }, milliseconds); })]); }
  finally { clearTimeout(timer); }
}
const timeouts: Record<string, number> = { 'presence.speak': 100_000, 'bluetooth.local-list': 25_000 };

export class PresenceHosts {
  private origin: Awaited<ReturnType<typeof connectDaemon>>['client'];
  private remote = new Map<string, Promise<DaemonClient>>();
  private speech = new GuardSpeech();
  private stopped = false;
  constructor(origin: Awaited<ReturnType<typeof connectDaemon>>['client']) { this.origin = origin; }
  async hosts() {
    const result = await this.origin.listHosts();
    return [{ id: result.self.serverId, name: result.self.label, online: true }, ...result.hosts.filter(host => host.serverId).map(host => ({ id: host.serverId!, name: host.label || host.serverId!, online: host.enabled && host.status === 'online' }))];
  }
  private async client(hostId: string) {
    if (this.stopped) throw new Error('插件已停止');
    let connection = this.remote.get(hostId);
    if (!connection) {
      connection = (async () => {
        const scope = randomUUID();
        const route = await deadline(this.origin.openHostRoute(hostId, scope), 20_000, () => this.origin.cancelHostRoute(scope));
        const client = new DaemonClient({ url: 'ws://routed-host/ws', clientId: scope, transportFactory: createHostChannelTransport(this.origin, hostId, scope, route), reconnect: { enabled: false } });
        try { await deadline(client.connect(), 10_000); if (this.stopped) throw new Error('插件已停止'); return client; }
        catch (error) { await client.close(); throw error; }
      })();
      this.remote.set(hostId, connection);
    }
    return connection;
  }
  async invoke(hostId: string, method: 'presence.local' | 'presence.speak' | 'presence.speak-cancel' | 'bluetooth.local-list' | 'bluetooth.local-select', input: unknown, onTimeout?: () => void) {
    const speech = method === 'presence.speak' || method === 'presence.speak-cancel';
    return this.withHost(hostId, client => deadline(client.invokePluginRpc('github-subscriptions', method, input), timeouts[method] ?? 5000, onTimeout), speech);
  }
  async localSpeech(id: string, text: string) {
    return this.speech.speak(id, text);
  }
  localCancel(id: string) { return this.speech.cancel(id); }
  async cancelSpeech(hostId: string | null, id: string) {
    const self = this.origin.getLastServerInfoMessage()?.serverId;
    if (hostId && hostId !== self) await this.invoke(hostId, 'presence.speak-cancel', { id });
    else this.localCancel(id);
  }
  async withHost<T>(hostId: string, operation: (client: DaemonClient) => Promise<T>, keepOnTimeout = false): Promise<T> {
    const connection = this.client(hostId);
    let connected = false;
    try { const client = await connection; connected = true; return await operation(client); }
    catch (error) {
      if (connected && keepOnTimeout && error instanceof DeadlineError) throw error;
      const previous = this.remote.get(hostId); this.remote.delete(hostId); await previous?.then(client => client.close(), () => {}); throw error;
    }
  }
  async observe(hostId: string | null) {
    const self = this.origin.getLastServerInfoMessage()?.serverId;
    return hostId && hostId !== self ? PresenceObservationSchema.parse(await this.invoke(hostId, 'presence.local', {})) : readGuardPresence();
  }
  sameHost(left: string | null, right: string | null) {
    const local = this.origin.getLastServerInfoMessage()?.serverId;
    return (left ?? local) === (right ?? local);
  }
  async bluetooth(hostId: string | null) {
    return this.sameHost(hostId, null) ? listBluetoothTargets() : BluetoothSnapshotSchema.parse(await this.invoke(hostId!, 'bluetooth.local-list', {}));
  }
  async selectBluetooth(hostId: string | null, target: BluetoothTarget) {
    return this.sameHost(hostId, null) ? saveBluetoothTarget(target) : BluetoothConfigSchema.parse(await this.invoke(hostId!, 'bluetooth.local-select', target));
  }
  async speak(hostId: string | null, id: string, text: string) {
    const self = this.origin.getLastServerInfoMessage()?.serverId;
    if (hostId && hostId !== self) return SpeechResultSchema.parse(await this.invoke(hostId, 'presence.speak', { id, text }, () => { void this.cancelSpeech(hostId, id).catch(() => {}); }));
    return this.localSpeech(id, text);
  }
  async stop() { this.stopped = true; this.speech.stop(); await Promise.allSettled([...this.remote.values()].map(connection => connection.then(client => client.close()))); this.remote.clear(); }
}

export function presencePort(connection: Awaited<ReturnType<typeof connectDaemon>>, hosts: PresenceHosts): PresencePort {
  return {
    async list() {
      const agents: QuestionAgent[] = []; let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await connection.paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 100, cursor } });
        agents.push(...result.entries.map(entry => entry.agent));
        if (!result.pageInfo.hasMore) return agents;
        if (!result.pageInfo.nextCursor || result.pageInfo.nextCursor === cursor) break;
        cursor = result.pageInfo.nextCursor;
      }
      throw new Error('会话清单未完整返回');
    },
    async refresh(id) { return (await connection.paseo.agents.ref(id).refresh())?.agent ?? null; },
    respond: connection.respond,
    observe: hostId => hosts.observe(hostId),
    speak: (hostId, id, text) => hosts.speak(hostId, id, text),
    cancelSpeech: (hostId, id) => hosts.cancelSpeech(hostId, id),
    hosts: () => hosts.hosts(),
  };
}
