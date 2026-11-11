import type { PluginClientContext } from '@getpaseo/plugin/client';
import { useEffect, useMemo, useState, useSyncExternalStore, type ComponentType } from 'react';
import { Pressable, ScrollView, Text, TextInput, View, type TextStyle, type ViewStyle } from 'react-native';
import contribute from '../../index.client.tsx';
import { FakeDaemon } from './fake-daemon.ts';
import { agents, type Scene } from './fixtures.ts';
import { HostThemeContext, toastBus, type MockHostTheme, type ToastVariant } from './mocks/host-context.ts';
import { Registry, type PillEntry } from './registry.ts';

export interface PreviewOptions {
  scene: Scene;
  layout: 'wide' | 'compact';
  theme: 'light' | 'dark';
  /** 例如 screen:main、agent:agent-main */
  route: string;
}

// 颜色取自界面稿的主题变量，是近似值，不是 Paseo 原生主题。
const themes: Record<'light' | 'dark', MockHostTheme> = {
  light: { colors: { surface0: '#ffffff', surface1: '#f6f6f6', surface2: '#ececee', border: '#e4e4e7', foreground: '#1f1f22', foregroundMuted: '#8a8a90', accent: '#2f6bf0', accentForeground: '#ffffff', statusSuccess: '#2e9a52', statusWarning: '#c27a07', statusDanger: '#d6403a' } },
  dark: { colors: { surface0: '#151517', surface1: '#1c1c1f', surface2: '#2b2b2f', border: '#303035', foreground: '#ececef', foregroundMuted: '#8e8e95', accent: '#5b8cff', accentForeground: '#ffffff', statusSuccess: '#4cc274', statusWarning: '#e3a33b', statusDanger: '#ff6b66' } },
};

type Route =
  | { kind: 'screen'; screenId: string; params: Record<string, string> }
  | { kind: 'agent'; agentId: string };
type Popover = { kind: 'sidebar' | 'pill'; Content: ComponentType<never>; props: Record<string, unknown> } | null;

function parseRoute(text: string): Route {
  const [rawTarget, rawQuery] = text.split('?');
  const [kind, id] = (rawTarget ?? '').split(':');
  const params: Record<string, string> = {};
  if (rawQuery) {
    for (const pair of rawQuery.split('&')) {
      const [k, v] = pair.split('=');
      if (k) params[decodeURIComponent(k)] = decodeURIComponent(v ?? '');
    }
  }
  if (kind === 'agent' && id) return { kind: 'agent', agentId: id };
  return { kind: 'screen', screenId: id || 'main', params };
}

export interface PreviewHandle {
  daemon: FakeDaemon;
  registry: Registry;
  /** 调用插件入口返回的清理函数，用来验收清理是否完整。 */
  dispose(): void;
  consoleLog: string[];
}

export function createPreview(options: PreviewOptions) {
  const daemon = new FakeDaemon(options.scene);
  const registry = new Registry();
  const consoleLog: string[] = [];
  const route = { current: parseRoute(options.route), set: (_next: Route) => {} };

  const client = {
    paseo: {
      agents: {
        ref(agentId: string) {
          const found = agents.find((agent) => agent.id === agentId);
          return { id: agentId, workspaceId: found?.workspaceId ?? null, refresh: async () => null };
        },
        async list() {
          return {
            entries: agents.map(a => ({ agent: { id: a.id, title: a.title, status: 'idle', archivedAt: null } })),
            pageInfo: { hasMore: false },
          };
        },
      },
    },
    rpc: (contract: Parameters<FakeDaemon['rpc']>[0], input: unknown) => daemon.rpc(contract, input),
    openScreen: (input: { screenId: string; params?: Record<string, string> }) => route.set({ kind: 'screen', screenId: input.screenId, params: input.params ?? {} }),
    openPanel: (id: string, panelOptions: { workspaceId: string; agentId?: string }) => registry.openPanel(id, panelOptions),
    addScreen: (entry: Parameters<Registry['addScreen']>[0]) => registry.addScreen(entry),
    addSidebarHeaderItem: (entry: Parameters<Registry['addSidebar']>[0]) => registry.addSidebar(entry),
    addAgentPanel: (entry: Parameters<Registry['addAgentPanel']>[0]) => registry.addAgentPanel(entry),
    addCommandCenterItem: (entry: Parameters<Registry['addCommandCenterItem']>[0]) => registry.addCommandCenterItem(entry),
    addComposerPill: (entry: PillEntry) => registry.addPill(entry),
  } as unknown as PluginClientContext;

  let cleanup: (() => void | Promise<void>) | null = contribute(client);
  const handle: PreviewHandle = {
    daemon,
    registry,
    consoleLog,
    dispose() {
      const done = cleanup;
      cleanup = null;
      void done?.();
    },
  };

  function App() {
    const colors = themes[options.theme];
    const c = colors.colors;
    const compact = options.layout === 'compact';
    const [current, setCurrent] = useState<Route>(route.current);
    route.set = (next) => {
      route.current = next;
      setCurrent(next);
      setDrawer(false);
      setPopover(null);
    };
    const [popover, setPopover] = useState<Popover>(null);
    const [drawer, setDrawer] = useState(false);
    const [toast, setToast] = useState<{ message: string; variant: ToastVariant } | null>(null);
    useSyncExternalStore(registry.subscribe, registry.getVersion);

    useEffect(() => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stop = toastBus.subscribe((message, variant) => {
        setToast({ message, variant });
        clearTimeout(timer);
        timer = setTimeout(() => setToast(null), 3000);
      });
      return () => {
        stop();
        clearTimeout(timer);
      };
    }, []);

    const hostProps = useMemo(() => ({ theme: colors, host: { id: 'fixture', label: '预览主机' }, layout: { compact, platform: 'web' as const } }), [colors, compact]);
    const text = (size: number, muted = false): TextStyle => ({ color: muted ? c.foregroundMuted : c.foreground, fontSize: size });

    const sidebar = (
      <View style={{ width: compact ? 290 : 250, backgroundColor: c.surface1, paddingTop: 16, gap: 2, borderRightWidth: 1, borderRightColor: c.border, height: '100%' }}>
        {['新建工作区', '历史', '搜索'].map((label) => (
          <View key={label} style={{ paddingVertical: 10, paddingHorizontal: 20 }}>
            <Text style={text(14)}>{label}</Text>
          </View>
        ))}
        {[...registry.sidebar.values()].map((entry) => {
          const Item = entry.Component as ComponentType<Record<string, unknown>>;
          return (
            <Item
              key={entry.id}
              {...hostProps}
              currentScreen={current.kind === 'screen' ? { screenId: current.screenId, params: current.params } : null}
              openScreen={(input: { screenId: string; params?: Record<string, string> }) => route.set({ kind: 'screen', screenId: input.screenId, params: input.params ?? {} })}
              openPopover={(Content: ComponentType<never>) => setPopover({ kind: 'sidebar', Content, props: {} })}
            />
          );
        })}
        <View style={{ height: 1, backgroundColor: c.border, marginVertical: 8, marginHorizontal: 12 }} />
        <Text style={[text(12, true), { paddingHorizontal: 20, paddingBottom: 4 }]}>已置顶</Text>
        {agents.map((agent) => (
          <Pressable key={agent.id} accessibilityRole="button" accessibilityLabel={`打开会话 ${agent.title}`} onPress={() => route.set({ kind: 'agent', agentId: agent.id })} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, paddingHorizontal: 20, backgroundColor: current.kind === 'agent' && current.agentId === agent.id ? c.surface2 : 'transparent', marginHorizontal: 8, borderRadius: 10 }}>
            <Text style={[text(13), { flex: 1 }]} numberOfLines={1}>
              {agent.parentAgentId ? '└ ' : ''}
              {agent.title}
            </Text>
            <Text style={text(12, true)}>{agent.pinnedFor}</Text>
          </Pressable>
        ))}
      </View>
    );

    let body: React.ReactNode;
    let title = '';
    if (current.kind === 'screen') {
      const screen = registry.screens.get(current.screenId);
      if (!screen) {
        body = <Text style={[text(14), { padding: 24 }]}>页面 {current.screenId} 不存在（插件未注册或已清理）</Text>;
      } else {
        title = typeof screen.title === 'function' ? screen.title(current.params) : screen.title;
        const Screen = screen.Component as ComponentType<Record<string, unknown>>;
        body = (
          <Screen
            {...hostProps}
            params={current.params}
            navigation={{ openAgent: ({ agentId }: { agentId: string }) => route.set({ kind: 'agent', agentId }), openWorkspace: () => undefined }}
          />
        );
      }
    } else {
      const agent = agents.find((item) => item.id === current.agentId);
      title = agent?.title ?? '会话';
      const pills = [...registry.pills.values()].filter((pill) => pill.agentId === current.agentId && pill.button.visible !== false);
      body = (
        <View style={{ flex: 1 }}>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, gap: 14 }}>
            <View style={{ alignSelf: 'flex-end', backgroundColor: c.surface2, borderRadius: 16, padding: 12, maxWidth: '80%' }}>
              <Text style={text(14)}>PR 的 CI 跑完后告诉我结果，有 Review 意见也直接处理。</Text>
            </View>
            <Text style={text(14)}>已订阅这个 PR。CI 结果出来时，插件会直接把消息发到这个会话，我不用空转等待。</Text>
          </ScrollView>
          <View style={{ padding: 12, gap: 8 }}>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <View style={{ borderRadius: 999, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border, paddingHorizontal: 12, paddingVertical: 6 }}>
                <Text style={text(13, true)}>5 个 subagent</Text>
              </View>
              {pills.map((pill) => {
                const behavior = pill.button.behavior;
                return (
                  <Pressable
                    key={`${pill.agentId}:${pill.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={pill.button.title}
                    disabled={pill.button.disabled}
                    onPress={() => {
                      if (behavior.kind === 'popover') setPopover({ kind: 'pill', Content: behavior.Content, props: { context: 'agent', workspaceId: pill.workspaceId, agentId: pill.agentId } });
                      else if (behavior.kind === 'action') void behavior.onPress();
                    }}
                    style={{ flexDirection: 'row', gap: 6, alignItems: 'center', borderRadius: 999, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border, paddingHorizontal: 12, paddingVertical: 6 }}
                  >
                    <Text style={text(13)}>{pill.button.label ?? pill.button.title}</Text>
                    {behavior.kind === 'popover' ? <Text style={text(11, true)}>︿</Text> : null}
                  </Pressable>
                );
              })}
            </View>
            <TextInput editable={false} placeholder="给 Agent 发消息，标记 @files，或使用 /commands 和 /skills" placeholderTextColor={c.foregroundMuted} style={{ borderWidth: 1, borderColor: c.border, borderRadius: 14, padding: 14, color: c.foreground, backgroundColor: c.surface0 } as ViewStyle & TextStyle} />
          </View>
        </View>
      );
    }

    const sheet = popover
      ? (() => {
          const Content = popover.Content as ComponentType<Record<string, unknown>>;
          const inner = (
            <HostThemeContext.Provider value={colors}>
              <Content {...hostProps} {...popover.props} close={() => setPopover(null)} openScreen={(input: { screenId: string }) => route.set({ kind: 'screen', screenId: input.screenId, params: {} })} />
            </HostThemeContext.Provider>
          );
          const box: ViewStyle = { backgroundColor: c.surface0, borderColor: c.border, borderWidth: 1, borderRadius: compact ? 16 : 14, overflow: 'hidden', shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 20 };
          return (
            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
              <Pressable accessibilityLabel="关闭弹出层" onPress={() => setPopover(null)} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: compact ? 'rgba(0,0,0,0.35)' : 'transparent' }} />
              <View style={compact ? [box, { position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '75%', borderBottomLeftRadius: 0, borderBottomRightRadius: 0 }] : [box, popover.kind === 'pill' ? { position: 'absolute', left: 280, bottom: 110, width: 440, maxHeight: 420 } : { position: 'absolute', left: 260, top: 120, width: 360, maxHeight: 420 }]}>
                <ScrollView>{inner}</ScrollView>
              </View>
            </View>
          );
        })()
      : null;

    return (
      <HostThemeContext.Provider value={colors}>
        <View style={{ flex: 1, flexDirection: 'row', backgroundColor: c.surface0, overflow: 'hidden' }}>
          {!compact ? sidebar : null}
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={{ height: 48, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: c.border }}>
              {compact ? (
                <Pressable accessibilityRole="button" accessibilityLabel="打开侧边栏" onPress={() => setDrawer(true)}>
                  <Text style={text(18)}>☰</Text>
                </Pressable>
              ) : null}
              <Text style={[text(14), { flex: 1 }]} numberOfLines={1}>
                {title}
              </Text>
              {current.kind === 'screen' ? (
                <Pressable accessibilityRole="button" accessibilityLabel="关闭页面" onPress={() => route.set({ kind: 'agent', agentId: 'agent-main' })}>
                  <Text style={text(16, true)}>×</Text>
                </Pressable>
              ) : null}
            </View>
            <View style={{ flex: 1, minHeight: 0 }}>{body}</View>
          </View>
          {compact && drawer ? (
            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, flexDirection: 'row' }}>
              {sidebar}
              <Pressable accessibilityLabel="关闭侧边栏" onPress={() => setDrawer(false)} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' }} />
            </View>
          ) : null}
          {sheet}
          {toast ? (
            <View style={{ position: 'absolute', bottom: 16, alignSelf: 'center', left: 16, right: 16, alignItems: 'center' }} pointerEvents="none">
              <View accessibilityRole="alert" style={{ backgroundColor: c.surface2, borderColor: toast.variant === 'error' ? c.statusDanger : c.border, borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8 }}>
                <Text style={text(13)}>{toast.message}</Text>
              </View>
            </View>
          ) : null}
        </View>
      </HostThemeContext.Provider>
    );
  }

  return { App, handle };
}
