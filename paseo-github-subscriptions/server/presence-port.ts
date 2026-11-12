import type { connectDaemon } from './daemon.ts';
import { isMissingRpcMethodError, type PresencePort, type QuestionAgent } from './presence.ts';
import { LocalSpeechStateSchema, PresenceObservationSchema } from '../shared/presence.ts';
import { readGuardPresence } from './guard-presence.ts';
import { GuardSpeech } from './speech.ts';
import { SpeechResultSchema } from '../shared/speech.ts';
import { listBluetoothTargets, saveBluetoothTarget } from './bluetooth-target.ts';
import { BluetoothConfigSchema, BluetoothSnapshotSchema, type BluetoothTarget } from '../shared/bluetooth.ts';
import { HostRouter } from './core/hosts.ts';

const timeouts: Record<string, number> = { 'presence.speak': 100_000, 'bluetooth.local-list': 25_000, 'presence.local-speech': 3_000 };

export { isMissingRpcMethodError };

export class PresenceHosts extends HostRouter {
  private speech = new GuardSpeech();
  constructor(origin: Awaited<ReturnType<typeof connectDaemon>>['client']) { super(origin); }
  async invoke(hostId: string, method: 'presence.local' | 'presence.local-speech' | 'presence.speak' | 'presence.speak-cancel' | 'bluetooth.local-list' | 'bluetooth.local-select' | 'todo.local' | 'todo.act', input: unknown, onTimeout?: () => void) {
    return this.invokePlugin(hostId, method, input, timeouts[method] ?? 5000, onTimeout, true);
  }
  async localSpeech(id: string, text: string) {
    return this.speech.speak(id, text);
  }
  localCancel(id: string) { return this.speech.cancel(id); }
  async cancelSpeech(hostId: string | null, id: string) {
    if (!this.sameHost(hostId, null)) await this.invoke(hostId!, 'presence.speak-cancel', { id });
    else this.localCancel(id);
  }
  async observe(hostId: string | null) {
    return !this.sameHost(hostId, null) ? PresenceObservationSchema.parse(await this.invoke(hostId!, 'presence.local', {})) : readGuardPresence();
  }
  async remoteSpeechState(hostId: string): Promise<{ enabled: boolean; configured: boolean }> {
    if (this.sameHost(hostId, null)) return { enabled: true, configured: true };
    try {
      const parsed = LocalSpeechStateSchema.parse(await this.invoke(hostId, 'presence.local-speech', {}));
      return { enabled: parsed.enabled, configured: parsed.configured ?? true };
    } catch (error) {
      if (isMissingRpcMethodError(error)) {
        return { enabled: false, configured: false };
      }
      throw error;
    }
  }
  async remoteSpeechEnabled(hostId: string): Promise<boolean> {
    return (await this.remoteSpeechState(hostId)).enabled;
  }
  async bluetooth(hostId: string | null) {
    return this.sameHost(hostId, null) ? listBluetoothTargets() : BluetoothSnapshotSchema.parse(await this.invoke(hostId!, 'bluetooth.local-list', {}));
  }
  async selectBluetooth(hostId: string | null, target: BluetoothTarget) {
    return this.sameHost(hostId, null) ? saveBluetoothTarget(target) : BluetoothConfigSchema.parse(await this.invoke(hostId!, 'bluetooth.local-select', target));
  }
  async speak(hostId: string | null, id: string, text: string) {
    if (!this.sameHost(hostId, null)) return SpeechResultSchema.parse(await this.invoke(hostId!, 'presence.speak', { id, text }, () => { void this.cancelSpeech(hostId, id).catch(() => {}); }));
    return this.localSpeech(id, text);
  }
  override async stop() { this.speech.stop(); await super.stop(); }
}

// 语音播报用工作区名称；读取失败时调用方退回会话名称。
async function workspaceNames(connection: Awaited<ReturnType<typeof connectDaemon>>) {
  const names = new Map<string, string>(); let cursor: string | undefined;
  const filter = connection.client.supportsBackgroundWorkspaces() ? { includeBackground: true } : {};
  for (let page = 0; page < 10; page++) {
    const result = await connection.paseo.workspaces.list({ filter, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    for (const workspace of result.entries) if (workspace.name) names.set(workspace.id, workspace.name);
    if (!result.pageInfo.nextCursor || result.pageInfo.nextCursor === cursor) break;
    cursor = result.pageInfo.nextCursor;
  }
  return names;
}

export function presencePort(connection: Awaited<ReturnType<typeof connectDaemon>>, hosts: PresenceHosts): PresencePort {
  return {
    async list() {
      const agents: (QuestionAgent & { workspaceId?: string })[] = []; let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await connection.paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 100, cursor } });
        agents.push(...result.entries.map(entry => entry.agent));
        if (!result.pageInfo.hasMore) {
          const names = await workspaceNames(connection).catch(() => new Map<string, string>());
          return agents.map(agent => ({ ...agent, workspaceName: agent.workspaceId ? names.get(agent.workspaceId) ?? null : null }));
        }
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
    selfId: () => {
      const id = hosts.selfId();
      return id === 'local' ? null : id;
    },
    remoteSpeechEnabled: hostId => hosts.remoteSpeechEnabled(hostId),
    remoteSpeechState: hostId => hosts.remoteSpeechState(hostId),
  };
}
