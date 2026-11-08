import type { PluginScreenProps } from '@getpaseo/plugin/client';
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Btn, Notice, Segmented, useStoreState, useUi } from '../ui.tsx';
import { EventsTab } from './events.tsx';
import { StatusTab } from './status.tsx';
import { SubscriptionsTab } from './subscriptions.tsx';

type Tab = 'subs' | 'events' | 'status';

function isTab(value: string | undefined): value is Tab {
  return value === 'subs' || value === 'events' || value === 'status';
}

export function GitHubPanel({ params }: Pick<PluginScreenProps, 'params'>) {
  const { s, openScreen } = useUi();
  const { snapshot, error } = useStoreState();
  const [tab, setTab] = useState<Tab>(isTab(params.tab) ? params.tab : 'subs');
  const prefs = snapshot?.preferences;
  const watched = snapshot?.repositories.length ?? 0;

  return (
    <View style={{ gap: 16 }}>
      <View style={[s.row, { justifyContent: 'space-between', alignItems: 'flex-start' }]}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={s.h1}>GitHub 订阅</Text>
          {prefs ? (
            <Text style={s.muted}>
              组织 {prefs.organization} · 监听 {watched} 个仓库 · 每 {snapshot?.intervalSeconds ?? 60} 秒轮询 · 送达方式：{prefs.shadow ? '影子模式（只记日志）' : '实际发送'}
            </Text>
          ) : null}
        </View>
        <Btn label="设置" onPress={() => openScreen({ screenId: 'settings' })} />
      </View>
      {prefs?.shadow ? (
        <Notice tone="warning">
          <Text style={s.strong}>影子模式已开启</Text>
          <Text style={s.muted}>事件只写入记录，不会发给任何会话。确认事件正确后，在设置页关闭影子模式才会实际发送。</Text>
        </Notice>
      ) : null}
      {prefs && !prefs.enabled ? (
        <Notice tone="warning">
          <Text style={s.strong}>监听已暂停</Text>
          <Text style={s.muted}>在设置页重新开启后才会轮询 GitHub。</Text>
        </Notice>
      ) : null}
      {snapshot && !snapshot.token.configured ? (
        <Notice tone="warning">
          <Text style={s.strong}>还没有保存 GitHub 令牌</Text>
          <Text style={s.muted}>没有令牌无法读取 GitHub。请到设置页填写。</Text>
        </Notice>
      ) : null}
      {error && !snapshot ? (
        <Notice tone="danger">
          <Text style={s.strong}>无法连接插件服务</Text>
          <Text style={s.muted}>{error}</Text>
        </Notice>
      ) : null}
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: 'subs', label: '订阅' },
          { value: 'events', label: '事件' },
          { value: 'status', label: '监听状态' },
        ]}
      />
      {tab === 'subs' ? <SubscriptionsTab /> : tab === 'events' ? <EventsTab /> : <StatusTab />}
    </View>
  );
}
