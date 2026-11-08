import type { PluginSidebarItemProps } from '@getpaseo/plugin/client';
import { SidebarRow } from '@getpaseo/plugin/client/ui';
import { Text } from 'react-native';
import { githubIcon } from './icons.ts';
import { useStoreState, useUi } from './ui.tsx';

const HOUR_MS = 3_600_000;

export function SidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const { theme, now } = useUi();
  const { snapshot, error } = useStoreState();
  const recent = snapshot ? snapshot.events.filter((event) => now - Date.parse(event.at) < HOUR_MS).length : 0;
  const problem = Boolean(error) || Boolean(snapshot?.error) || Boolean(snapshot?.repositories.some((repo) => repo.error));
  const shadow = snapshot?.preferences.shadow ?? true;
  const text = problem ? '!' : recent > 0 ? String(recent) : shadow ? '影子' : '';
  const color = problem ? theme.colors.statusWarning : theme.colors.foregroundMuted;
  const active = currentScreen?.screenId === 'main' || currentScreen?.screenId === 'settings';
  return (
    <SidebarRow
      icon={githubIcon}
      label="开发自动化"
      active={active}
      onPress={() => openScreen({ screenId: 'main' })}
      trailing={text ? <Text style={{ color, fontSize: 12, paddingRight: 8 }}>{text}</Text> : undefined}
    />
  );
}
