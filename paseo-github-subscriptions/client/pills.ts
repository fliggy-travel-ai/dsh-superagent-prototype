import type { PluginButtonContentProps, PluginButtonRegistration, PluginClientContext } from '@getpaseo/plugin/client';
import type { ComponentType } from 'react';
import { githubIcon } from './icons.ts';
import type { SnapshotStore } from './store.ts';

const PILL_ID = 'github';
const RETRY_AFTER_MS = 30_000;

interface Pill {
  registration: PluginButtonRegistration;
  label: string;
}

function labelFor(count: number, shadow: boolean): string {
  return shadow ? `GitHub · ${count} · 影子` : `GitHub · ${count}`;
}

/** 每个有订阅的会话一个胶囊；订阅清零或会话消失时移除；清理时全部移除。 */
export function createPills(
  client: Pick<PluginClientContext, 'addComposerPill' | 'paseo'>,
  store: SnapshotStore,
  Content: ComponentType<PluginButtonContentProps>,
) {
  const pills = new Map<string, Pill>();
  const workspaces = new Map<string, string>();
  const resolving = new Set<string>();
  const retryAt = new Map<string, number>();
  let disposed = false;

  const add = (agentId: string, workspaceId: string, count: number, shadow: boolean) => {
    if (disposed || pills.has(agentId)) return;
    const label = labelFor(count, shadow);
    try {
      const registration = client.addComposerPill({
        id: PILL_ID,
        workspaceId,
        agentId,
        button: {
          title: 'GitHub 订阅',
          icon: githubIcon,
          label,
          behavior: { kind: 'popover', Content },
        },
      });
      pills.set(agentId, { registration, label });
    } catch (error) {
      console.error('GitHub 订阅胶囊注册失败', error);
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
    const { snapshot } = store.getState();
    if (!snapshot) return;
    const shadow = snapshot.preferences.shadow;
    const counts = new Map<string, { count: number; workspaceId: string | null }>();
    for (const sub of snapshot.subscriptions) {
      const entry = counts.get(sub.agentId) ?? { count: 0, workspaceId: sub.workspaceId };
      entry.count += 1;
      counts.set(sub.agentId, entry);
    }
    for (const [agentId, pill] of [...pills]) {
      if (counts.has(agentId)) continue;
      pill.registration.remove();
      pills.delete(agentId);
    }
    for (const [agentId, { count, workspaceId }] of counts) {
      const known = workspaceId ?? workspaces.get(agentId) ?? null;
      const pill = pills.get(agentId);
      if (pill) {
        const label = labelFor(count, shadow);
        if (label !== pill.label) {
          pill.registration.update({ label });
          pill.label = label;
        }
      } else if (known) {
        add(agentId, known, count, shadow);
      } else {
        void resolveWorkspace(agentId);
      }
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
