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
  const count = computeTodoCount(controlState);
  const active = currentScreen?.screenId === 'main';

  return (
    <SidebarRow
      icon={githubIcon}
      label="开发自动化"
      active={active}
      onPress={() => openScreen({ screenId: 'main', params: { page: count > 0 && !hasAlert ? 'todo' : getLastNonTodoPage() } })}
      trailing={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginRight: 4 }}>
          {hasAlert ? (
            <Text style={{ color: theme.colors.statusDanger, fontSize: 12, fontWeight: '700' }}>!</Text>
          ) : null}
          {count > 0 ? (
            <View
              style={{
                backgroundColor: theme.colors.surface2,
                borderColor: theme.colors.statusWarning,
                borderWidth: 1,
                borderRadius: 999,
                paddingHorizontal: 7,
                paddingVertical: 1,
              }}
            >
              <Text style={{ color: theme.colors.statusWarning, fontSize: 11, fontWeight: '600' }}>{count}</Text>
            </View>
          ) : !hasAlert ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, paddingRight: 4 }}>0</Text>
          ) : null}
        </View>
      }
    />
  );
}
