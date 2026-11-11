import type { PluginClientContext } from '@getpaseo/plugin/client';
import { createPills } from './client/pills.ts';
import { PillPopover } from './client/pill-popover.tsx';
import { MainScreen } from './client/dashboard.tsx';
import { SidebarItem } from './client/sidebar-item.tsx';
import { registerQuotaResume } from './client/quota-resume/register.tsx';
import { createSnapshotStore } from './client/store.ts';
import { createControlStore } from './client/control-store.ts';
import { githubIcon } from './client/icons.ts';
import { bind, type Env } from './client/ui.tsx';
import { createHeartbeatsPanel } from './client/heartbeats/panel.tsx';
import { createHeartbeatPills, HEARTBEATS_PANEL_ID } from './client/heartbeats/pills.ts';
import { createHeartbeatStore } from './client/heartbeats/store.ts';
import { INSTANCE_ROLE } from './shared/instance.ts';
import { resolveInstance } from './shared/instances.ts';

export default function contribute(client: PluginClientContext) {
  // Provider 实例不注册任何界面，避免侧栏和页面出现两份。
  if (!resolveInstance(INSTANCE_ROLE).hostsUi) return () => {};
  const store = createSnapshotStore(client);
  const control = createControlStore(client, client.paseo.agents.list);
  const heartbeatStore = createHeartbeatStore(client);
  const env: Env = {
    store,
    control,
    openScreen: input => client.openScreen(input),
  };

  const setPresenceMode = async (mode: 'online' | 'offline' | 'auto') => {
    const current = control.getState().presence?.settings ?? {
      mode: 'auto',
      paused: false,
      speechEnabled: true,
      sourceHostId: null,
    };
    await control.configurePresence({ ...current, mode });
  };

  const removers = [
    client.addScreen({ id: 'main', title: '开发自动化', Component: bind(env, MainScreen) }),
    client.addSidebarHeaderItem({ id: 'main', title: '开发自动化', Component: bind(env, SidebarItem) }),
    client.addAgentPanel?.({
      id: HEARTBEATS_PANEL_ID,
      title: '心跳',
      icon: 'HeartPulse',
      Component: createHeartbeatsPanel(heartbeatStore),
    }),
    client.addCommandCenterItem?.({
      id: 'open-heartbeats',
      title: '打开心跳面板',
      icon: 'HeartPulse',
      keywords: ['heartbeat', 'heartbeats', '心跳', '定时'],
      context: 'agent',
      onSelect: ctx => ctx.openPanel(HEARTBEATS_PANEL_ID),
    }),
    client.addCommandCenterItem?.({
      id: 'open-todo',
      title: '打开待办总览',
      icon: githubIcon,
      keywords: ['todo', '待办', '提问', '停滞', '升级'],
      context: 'global',
      onSelect: ctx => ctx.openScreen({ screenId: 'main', params: { page: 'todo' } }),
    }),
    client.addCommandCenterItem?.({
      id: 'qa-mode-online',
      title: '问答模式：切换为在线',
      icon: githubIcon,
      keywords: ['qa', 'online', '问答', '在线'],
      context: 'global',
      onSelect: () => setPresenceMode('online'),
    }),
    client.addCommandCenterItem?.({
      id: 'qa-mode-offline',
      title: '问答模式：切换为离线',
      icon: githubIcon,
      keywords: ['qa', 'offline', '问答', '离线'],
      context: 'global',
      onSelect: () => setPresenceMode('offline'),
    }),
    client.addCommandCenterItem?.({
      id: 'qa-mode-auto',
      title: '问答模式：切换为自动',
      icon: githubIcon,
      keywords: ['qa', 'auto', '问答', '自动', '蓝牙'],
      context: 'global',
      onSelect: () => setPresenceMode('auto'),
    }),
    client.addCommandCenterItem?.({
      id: 'pause-all',
      title: '暂停全部自动化',
      icon: githubIcon,
      keywords: ['pause', '暂停', '自动化'],
      context: 'global',
      onSelect: async () => {
        const paused = control.getState().machineSettings?.pausedAll ?? false;
        await control.pauseAll(!paused);
      },
    }),
  ].filter((remove): remove is NonNullable<typeof remove> => typeof remove === 'function');
  const pills = createPills(client, store, bind(env, PillPopover));
  const heartbeatPills = createHeartbeatPills(client, heartbeatStore);
  const quotaResume = registerQuotaResume(client);
  store.start();
  control.start();
  heartbeatStore.start();

  return () => {
    pills.dispose();
    heartbeatPills.dispose();
    quotaResume();
    store.dispose();
    control.dispose();
    heartbeatStore.dispose();
    for (const remove of removers) remove();
  };
}
