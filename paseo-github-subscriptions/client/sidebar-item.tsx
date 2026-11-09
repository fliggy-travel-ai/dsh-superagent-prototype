import type { PluginSidebarItemProps } from '@getpaseo/plugin/client';
import { SidebarRow } from '@getpaseo/plugin/client/ui';
import { Text, View } from 'react-native';
import { githubIcon } from './icons.ts';
import { computeHasAlert, computeTodoCount, getLastNonTodoPage, setLastNonTodoPage } from './sidebar-state.ts';
import { useControlState, useStoreState, useUi } from './ui.tsx';

export { computeHasAlert, computeTodoCount, getLastNonTodoPage, setLastNonTodoPage };

export function SidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const { theme } = useUi();
  const storeState = useStoreState();
  const controlState = useControlState();
  const hasAlert = computeHasAlert(storeState, controlState);
  const active = currentScreen?.screenId === 'main' && currentScreen?.params?.page !== 'todo';

  return (
    <SidebarRow
      icon={githubIcon}
      label="开发自动化"
      active={active}
      onPress={() => openScreen({ screenId: 'main', params: { page: getLastNonTodoPage() } })}
      trailing={
        hasAlert ? (
          <Text style={{ color: theme.colors.statusDanger, fontSize: 12, fontWeight: '700', paddingRight: 8 }}>!</Text>
        ) : undefined
      }
    />
  );
}

export function SidebarTodoItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const { theme } = useUi();
  const controlState = useControlState();
  const count = computeTodoCount(controlState);
  const active = currentScreen?.screenId === 'main' && currentScreen?.params?.page === 'todo';

  return (
    <SidebarRow
      icon={githubIcon}
      label="待办"
      active={active}
      onPress={() => openScreen({ screenId: 'main', params: { page: 'todo' } })}
      trailing={
        count > 0 ? (
          <View
            style={{
              backgroundColor: theme.colors.surface2,
              borderColor: theme.colors.statusWarning,
              borderWidth: 1,
              borderRadius: 999,
              paddingHorizontal: 7,
              paddingVertical: 1,
              marginRight: 4,
            }}
          >
            <Text style={{ color: theme.colors.statusWarning, fontSize: 11, fontWeight: '600' }}>{count}</Text>
          </View>
        ) : (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, paddingRight: 8 }}>0</Text>
        )
      }
    />
  );
}
