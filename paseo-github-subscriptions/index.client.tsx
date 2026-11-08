import type { PluginClientContext } from '@getpaseo/plugin/client';
import { createPills } from './client/pills.ts';
import { PillPopover } from './client/pill-popover.tsx';
import { MainScreen, UsageSettingsScreen } from './client/dashboard.tsx';
import { SettingsScreen } from './client/settings/index.tsx';
import { SidebarItem } from './client/sidebar-item.tsx';
import { createSnapshotStore } from './client/store.ts';
import { createControlStore } from './client/control-store.ts';
import { bind, type Env } from './client/ui.tsx';
import { INSTANCE_ROLE } from './shared/instance.ts';
import { resolveInstance } from './shared/instances.ts';

export default function contribute(client: PluginClientContext) {
  // Provider 实例不注册任何界面，避免侧栏和页面出现两份。
  if (!resolveInstance(INSTANCE_ROLE).hostsUi) return () => {};
  const store = createSnapshotStore(client);
  const control = createControlStore(client, client.paseo.agents.list);
  const env: Env = { store, control, openScreen: (input) => client.openScreen(input) };

  const removers = [
    client.addScreen({ id: 'main', title: '开发自动化', Component: bind(env, MainScreen) }),
    client.addScreen({ id: 'settings', title: 'GitHub 订阅设置', Component: bind(env, SettingsScreen) }),
    client.addSidebarHeaderItem({ id: 'main', title: '开发自动化', Component: bind(env, SidebarItem) }),
    client.addSettingsScreen?.({ id: 'usage', title: '额度设置', icon: 'Gauge', Component: bind(env, UsageSettingsScreen) }),
  ].filter((remove): remove is NonNullable<typeof remove> => typeof remove === 'function');
  const pills = createPills(client, store, bind(env, PillPopover));
  store.start();
  control.start();

  return () => {
    pills.dispose();
    store.dispose();
    control.dispose();
    for (const remove of removers) remove();
  };
}
