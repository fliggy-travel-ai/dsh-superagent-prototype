import type { PluginClientContext } from '@getpaseo/plugin/client';
import { createPills } from './client/pills.ts';
import { PillPopover } from './client/pill-popover.tsx';
import { MainScreen } from './client/screen/index.tsx';
import { SettingsScreen } from './client/settings/index.tsx';
import { SidebarItem } from './client/sidebar-item.tsx';
import { createSnapshotStore } from './client/store.ts';
import { bind, type Env } from './client/ui.tsx';

export default function contribute(client: PluginClientContext) {
  const store = createSnapshotStore(client);
  const env: Env = { store, openScreen: (input) => client.openScreen(input) };

  const removers = [
    client.addScreen({ id: 'main', title: 'GitHub 订阅', Component: bind(env, MainScreen) }),
    client.addScreen({ id: 'settings', title: 'GitHub 订阅设置', Component: bind(env, SettingsScreen) }),
    client.addSidebarHeaderItem({ id: 'main', title: 'GitHub 订阅', Component: bind(env, SidebarItem) }),
  ];
  const pills = createPills(client, store, bind(env, PillPopover));
  store.start();

  return () => {
    pills.dispose();
    store.dispose();
    for (const remove of removers) remove();
  };
}
