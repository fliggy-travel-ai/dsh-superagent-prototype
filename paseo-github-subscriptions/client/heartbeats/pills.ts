import type { PluginButtonRegistration, PluginClientContext } from '@getpaseo/plugin/client';
import type { HeartbeatStore } from './store.ts';

export const HEARTBEATS_PANEL_ID = 'heartbeats';
const PILL_ID = 'heartbeats';
const RETRY_AFTER_MS = 30_000;

interface RegisteredHeartbeatPill {
  registration: PluginButtonRegistration;
  label: string;
}

/**
 * 代理心跳气泡：仅当该代理有心跳（数量 >= 1）时在输入框旁显示心跳数量；
 * 数量清零或清理插件时立即移除气泡。点击气泡打开该代理的心跳面板。
 */
export function createHeartbeatPills(
  client: Pick<PluginClientContext, 'addComposerPill' | 'paseo'> & {
    openPanel?: PluginClientContext['openPanel'];
  },
  store: HeartbeatStore,
) {
  const pills = new Map<string, RegisteredHeartbeatPill>();
  const workspaces = new Map<string, string>();
  const resolving = new Set<string>();
  const retryAt = new Map<string, number>();
  let disposed = false;

  const add = (agentId: string, workspaceId: string, count: number) => {
    if (disposed || count < 1 || pills.has(agentId)) return;
    const label = String(count);
    try {
      const registration = client.addComposerPill({
        id: PILL_ID,
        workspaceId,
        agentId,
        button: {
          title: '管理此代理的心跳',
          icon: 'HeartPulse',
          label,
          behavior: {
            kind: 'action',
            onPress() {
              client.openPanel?.(HEARTBEATS_PANEL_ID, { workspaceId, agentId });
            },
          },
        },
      });
      pills.set(agentId, { registration, label });
    } catch (error) {
      console.error('心跳气泡注册失败', error);
    }
  };

  const resolveWorkspace = async (agentId: string) => {
    if (resolving.has(agentId) || (retryAt.get(agentId) ?? 0) > Date.now()) return;
    resolving.add(agentId);
    try {
      const handle = client.paseo.agents.ref(agentId);
      await handle.refresh();
      if (handle.workspaceId) workspaces.set(agentId, handle.workspaceId);
      else retryAt.set(agentId, Date.now() + RETRY_AFTER_MS);
    } catch {
      retryAt.set(agentId, Date.now() + RETRY_AFTER_MS);
    } finally {
      resolving.delete(agentId);
    }
    if (!disposed) sync();
  };

  function sync() {
    if (disposed) return;
    const { counts } = store.getState();
    for (const [agentId, pill] of [...pills]) {
      const count = counts.get(agentId) ?? 0;
      if (count >= 1) continue;
      pill.registration.remove();
      pills.delete(agentId);
    }
    for (const [agentId, count] of counts) {
      if (count < 1) continue;
      const existing = pills.get(agentId);
      if (existing) {
        const label = String(count);
        if (label !== existing.label) {
          existing.registration.update({ label });
          existing.label = label;
        }
        continue;
      }
      const workspaceId = workspaces.get(agentId);
      if (workspaceId) add(agentId, workspaceId, count);
      else void resolveWorkspace(agentId);
    }
  }

  const stop = store.subscribe(sync);
  sync();

  return {
    dispose() {
      disposed = true;
      stop();
      for (const pill of pills.values()) pill.registration.remove();
      pills.clear();
    },
  };
}
