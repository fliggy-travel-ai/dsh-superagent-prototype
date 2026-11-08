import type { connectDaemon } from './daemon.ts';
import type { PresencePort, QuestionAgent } from './presence.ts';
import { PresenceObservationSchema } from '../shared/presence.ts';
import { readGuardPresence } from './guard-presence.ts';
import { GuardSpeech } from './speech.ts';
import { SpeechResultSchema } from '../shared/speech.ts';
import { listBluetoothTargets, saveBluetoothTarget } from './bluetooth-target.ts';
import { BluetoothConfigSchema, BluetoothSnapshotSchema, type BluetoothTarget } from '../shared/bluetooth.ts';
import { HostRouter } from './core/hosts.ts';

const timeouts: Record<string, number> = { 'presence.speak': 100_000, 'bluetooth.local-list': 25_000 };

export class PresenceHosts extends HostRouter {
  private speech = new GuardSpeech();
  constructor(origin: Awaited<ReturnType<typeof connectDaemon>>['client']) { super(origin); }
  async invoke(hostId: string, method: 'presence.local' | 'presence.speak' | 'presence.speak-cancel' | 'bluetooth.local-list' | 'bluetooth.local-select' | 'todo.local' | 'todo.act', input: unknown, onTimeout?: () => void) {
    const speech = method === 'presence.speak' || method === 'presence.speak-cancel';
    return this.invokePlugin(hostId, method, input, timeouts[method] ?? 5000, onTimeout, speech);
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
  async observe(hostId: string | null) {
    const self = this.origin.getLastServerInfoMessage()?.serverId;
    return hostId && hostId !== self ? PresenceObservationSchema.parse(await this.invoke(hostId, 'presence.local', {})) : readGuardPresence();
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
  override async stop() { this.speech.stop(); await super.stop(); }
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
