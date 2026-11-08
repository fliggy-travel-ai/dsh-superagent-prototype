import type { PluginHostProps, PluginSurfaceProps } from '@getpaseo/plugin/client';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from 'react';
import { Platform, Pressable, Text, View, type TextStyle, type ViewStyle } from 'react-native';
import type { SnapshotStore, StoreState } from './store.ts';
import type { ControlStore } from './control-store.ts';

type Theme = PluginHostProps['theme'];
type Navigation = PluginSurfaceProps['navigation'];
export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface Env {
  store: SnapshotStore;
  control: ControlStore;
  openScreen(input: { screenId: string; params?: Record<string, string> }): void;
}

interface UiValue extends Env {
  theme: Theme;
  compact: boolean;
  now: number;
  navigation: Navigation;
  s: ReturnType<typeof makeStyles>;
}

const UiContext = createContext<UiValue | null>(null);

export function useUi(): UiValue {
  const value = useContext(UiContext);
  if (!value) throw new Error('界面缺少上下文');
  return value;
}

export function useStoreState(): StoreState {
  const { store } = useUi();
  return useSyncExternalStore(store.subscribe, store.getState);
}

export function useControlState() {
  const { control } = useUi();
  return useSyncExternalStore(control.subscribe, control.getState);
}

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

function makeStyles(theme: Theme, compact: boolean) {
  const c = theme.colors;
  const pad = compact ? 12 : 16;
  return {
    page: { flex: 1, backgroundColor: c.surface0 },
    pageContent: { padding: compact ? 16 : 24, gap: 16, maxWidth: 1100, width: '100%', alignSelf: 'center' },
    h1: { color: c.foreground, fontSize: compact ? 20 : 24, fontWeight: '600' },
    h2: { color: c.foreground, fontSize: 15, fontWeight: '600' },
    text: { color: c.foreground, fontSize: 14, lineHeight: 20 },
    strong: { color: c.foreground, fontSize: 14, fontWeight: '600' },
    muted: { color: c.foregroundMuted, fontSize: 13, lineHeight: 18 },
    small: { color: c.foregroundMuted, fontSize: 12, lineHeight: 16 },
    mono: { color: c.foreground, fontSize: 13, fontFamily: mono },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    wrap: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
    stack: { gap: 4 },
    card: { backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 12, overflow: 'hidden' },
    cardHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      paddingHorizontal: pad,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    cardBody: { padding: pad, gap: 10 },
    item: { paddingHorizontal: pad, paddingVertical: 12, gap: 6, borderTopWidth: 1, borderTopColor: c.border },
    firstItem: { borderTopWidth: 0 },
    button: {
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    buttonPrimary: { backgroundColor: c.accent, borderColor: c.accent },
    buttonText: { color: c.foreground, fontSize: 13 },
    buttonPrimaryText: { color: c.accentForeground, fontSize: 13, fontWeight: '600' },
    input: {
      color: c.foreground,
      backgroundColor: c.surface2,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
      fontSize: 14,
      flexGrow: 1,
      minWidth: 120,
    },
    chip: { borderRadius: 999, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2, paddingHorizontal: 8, paddingVertical: 2 },
    segment: { flexDirection: 'row', alignSelf: 'flex-start', backgroundColor: c.surface2, borderRadius: 10, padding: 2, borderColor: c.border, borderWidth: 1 },
    segmentItem: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8 },
    segmentActive: { backgroundColor: c.surface0 },
    notice: { flexDirection: 'row', gap: 8, padding: 12, borderRadius: 10, borderWidth: 1 },
    bar: { height: 6, borderRadius: 3, backgroundColor: c.surface2, overflow: 'hidden' },
    barFill: { height: 6, backgroundColor: c.accent },
  } satisfies Record<string, ViewStyle | TextStyle>;
}

export function toneColor(theme: Theme, tone: Tone): string {
  const c = theme.colors;
  switch (tone) {
    case 'accent':
      return c.accent;
    case 'success':
      return c.statusSuccess;
    case 'warning':
      return c.statusWarning;
    case 'danger':
      return c.statusDanger;
    default:
      return c.foregroundMuted;
  }
}

/** 给每个注册进宿主的组件加上 store、主题与 30 秒时钟。 */
export function bind<P extends PluginHostProps>(env: Env, Inner: ComponentType<P>): ComponentType<P> {
  return function Bound(props: P) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
      const timer = setInterval(() => setNow(Date.now()), 30_000);
      return () => clearInterval(timer);
    }, []);
    const { theme } = props;
    const compact = props.layout.compact;
    const navigation = (props as Partial<PluginSurfaceProps>).navigation;
    const value = useMemo<UiValue>(
      () => ({ ...env, theme, compact, now, navigation, s: makeStyles(theme, compact) }),
      [theme, compact, now, navigation],
    );
    return (
      <UiContext.Provider value={value}>
        <Inner {...props} />
      </UiContext.Provider>
    );
  };
}

export function Chip({ label, tone = 'neutral' }: { label: string; tone?: Tone }) {
  const { s, theme } = useUi();
  const color = toneColor(theme, tone);
  return (
    <View style={[s.chip, tone === 'neutral' ? null : { borderColor: color }]}>
      <Text style={{ color: tone === 'neutral' ? theme.colors.foregroundMuted : color, fontSize: 12 }}>{label}</Text>
    </View>
  );
}

export function Btn(props: {
  label: string;
  onPress(): void;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  busy?: boolean;
  small?: boolean;
}) {
  const { s, theme } = useUi();
  const off = props.disabled || props.busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: off, busy: props.busy }}
      disabled={off}
      onPress={props.onPress}
      style={[s.button, props.primary ? s.buttonPrimary : null, props.small ? { paddingVertical: 4, paddingHorizontal: 8 } : null, off ? { opacity: 0.5 } : null]}
    >
      <Text
        style={[
          props.primary ? s.buttonPrimaryText : s.buttonText,
          props.danger ? { color: theme.colors.statusDanger } : null,
        ]}
      >
        {props.busy ? '处理中…' : props.label}
      </Text>
    </Pressable>
  );
}

export function Card(props: { title?: string; trailing?: ReactNode; children: ReactNode; flush?: boolean }) {
  const { s } = useUi();
  return (
    <View style={s.card}>
      {props.title ? (
        <View style={s.cardHeader}>
          <Text style={s.h2}>{props.title}</Text>
          {props.trailing}
        </View>
      ) : null}
      <View style={props.flush ? null : s.cardBody}>{props.children}</View>
    </View>
  );
}

export function Notice({ tone, children }: { tone: Tone; children: ReactNode }) {
  const { s, theme } = useUi();
  const color = toneColor(theme, tone);
  return (
    <View style={[s.notice, { borderColor: color, backgroundColor: theme.colors.surface1 }]} accessibilityRole="alert">
      <Text style={{ color, fontSize: 14, fontWeight: '600' }}>{tone === 'danger' ? '✕' : tone === 'warning' ? '!' : tone === 'success' ? '✓' : 'i'}</Text>
      <View style={{ flex: 1, gap: 2 }}>{children}</View>
    </View>
  );
}

export function Segmented<T extends string>(props: {
  options: readonly { value: NoInfer<T>; label: string }[];
  value: T;
  onChange(value: NoInfer<T>): void;
}) {
  const { s, theme } = useUi();
  return (
    <View style={s.segment} accessibilityRole="tablist">
      {props.options.map((option) => {
        const active = option.value === props.value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => props.onChange(option.value)}
            style={[s.segmentItem, active ? s.segmentActive : null]}
          >
            <Text style={{ color: active ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 14 }}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
