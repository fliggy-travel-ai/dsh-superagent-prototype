// 预览用：替代 @getpaseo/plugin/client/ui。样式是近似，不是 Paseo 原生样式。
import { useContext, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { HostThemeContext, toastBus, type ToastVariant } from './host-context.ts';

export function useToast() {
  return {
    show(message: string, options?: { variant?: ToastVariant }) {
      toastBus.emit(message, options?.variant ?? 'default');
    },
    error(message: string) {
      toastBus.emit(message, 'error');
    },
  };
}

interface RowProps {
  id?: string;
  icon?: string | { svg: string };
  label?: string;
  onPress(): void;
  active?: boolean;
  trailing?: ReactNode;
}

export function SidebarRow({ icon, label, onPress, active, trailing }: RowProps) {
  const theme = useContext(HostThemeContext);
  if (!theme) throw new Error('缺少宿主主题');
  const c = theme.colors;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', borderRadius: 10, backgroundColor: active ? c.surface2 : 'transparent', marginHorizontal: 8 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={label ?? 'GitHub 订阅'} onPress={onPress} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 12 }}>
        {/* 预览不渲染 SVG 图标，用圆环占位；真实图标由 Paseo 宿主绘制。 */}
        {icon ? <View style={{ width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: c.foregroundMuted }} /> : null}
        <Text style={{ color: c.foreground, fontSize: 14 }}>{label ?? 'GitHub 订阅'}</Text>
      </Pressable>
      {trailing}
    </View>
  );
}

export function SidebarSeparator() {
  const theme = useContext(HostThemeContext);
  return <View style={{ height: 1, backgroundColor: theme?.colors.border, marginVertical: 6 }} />;
}

export function Icon({ name }: { name?: string; size?: number; color?: string }) {
  return <Text>{name ?? '•'}</Text>;
}

export function StreamedText({ text }: { text?: string; isStreaming?: boolean; color?: string; fontSize?: number }) {
  return <Text>{text ?? ''}</Text>;
}
