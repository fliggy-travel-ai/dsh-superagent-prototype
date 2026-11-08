import type { PluginButtonContentProps } from '@getpaseo/plugin/client';
import { useToast } from '@getpaseo/plugin/client/ui';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { ago, eventTypesText, targetLabel } from './format.ts';
import { errorMessage } from './store.ts';
import { Btn, Chip, Notice, useStoreState, useUi } from './ui.tsx';

/** 胶囊弹出层：只列出当前会话的订阅，可取消，可打开全局页面。 */
export function PillPopover(props: PluginButtonContentProps) {
  const { s, store, openScreen, now, theme } = useUi();
  const toast = useToast();
  const { snapshot, error } = useStoreState();
  const [busyId, setBusyId] = useState<string | null>(null);
  const agentId = props.context === 'agent' ? props.agentId : null;
  const list = snapshot ? snapshot.subscriptions.filter((sub) => sub.agentId === agentId) : [];
  const shadow = snapshot?.preferences.shadow ?? true;

  const cancel = async (id: string) => {
    setBusyId(id);
    try {
      await store.unsubscribe(id);
    } catch (failure) {
      toast.error(`取消订阅失败：${errorMessage(failure)}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <View style={{ gap: 0, minWidth: props.layout.compact ? 0 : 360 }}>
      <View style={[s.cardHeader, { borderBottomWidth: 1 }]}>
        <Text style={s.h2}>本会话的 GitHub 订阅</Text>
        <Text style={s.muted}>{list.length}</Text>
      </View>
      {shadow ? (
        <View style={{ padding: 12 }}>
          <Notice tone="warning">
            <Text style={s.text}>影子模式：事件只记日志，不会发到本会话。</Text>
          </Notice>
        </View>
      ) : null}
      {error ? (
        <View style={{ padding: 12 }}>
          <Notice tone="danger">
            <Text style={s.text}>读取订阅失败：{error}</Text>
          </Notice>
        </View>
      ) : null}
      <View>
        {list.length === 0 ? (
          <Text style={[s.muted, { padding: 16 }]}>{snapshot ? '这个会话已没有订阅。' : '正在读取…'}</Text>
        ) : (
          list.map((sub, index) => (
            <View key={sub.id} style={[s.item, index === 0 ? s.firstItem : null]}>
              <View style={[s.row, { justifyContent: 'space-between' }]}>
                <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
                  <Text style={s.strong} numberOfLines={1}>
                    {targetLabel(sub)}
                  </Text>
                  <Text style={s.muted} numberOfLines={1}>
                    {sub.number ? sub.title ?? '' : '整个仓库'}
                  </Text>
                </View>
                <Btn small danger label="取消订阅" busy={busyId === sub.id} onPress={() => void cancel(sub.id)} />
              </View>
              <View style={s.wrap}>
                {eventTypesText(sub.events).map((label) => (
                  <Chip key={label} label={label} />
                ))}
                <Text style={s.small}>· 最近事件 {ago(sub.lastEventAt, now)}</Text>
              </View>
            </View>
          ))
        )}
      </View>
      <View style={[s.item, { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }]}>
        <Text style={[s.small, { flex: 1 }]}>{shadow ? '影子模式：不发送' : '有新事件时直接发到本会话'}</Text>
        <Pressable
          accessibilityRole="link"
          onPress={() => {
            props.close();
            openScreen({ screenId: 'main', params: { page: 'github' } });
          }}
        >
          <Text style={{ color: theme.colors.accent, fontSize: 13 }}>在 GitHub 订阅页查看全部 ›</Text>
        </Pressable>
      </View>
    </View>
  );
}
