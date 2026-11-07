import { useMemo, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import type { Delivery, GithubEvent } from '../../shared/model.ts';
import { ago, deliveryStatusLabels, eventHeadline, eventMatchesSubscription, eventTypeText, sessionTitle } from '../format.ts';
import { Card, Chip, Segmented, useStoreState, useUi, type Tone } from '../ui.tsx';

type Filter = 'all' | 'filtered' | 'bad' | 'none';
const PAGE = 100;

const statusTone: Record<Delivery['status'], Tone> = {
  pending: 'neutral',
  delivered: 'success',
  shadow: 'warning',
  skipped: 'neutral',
  unknown: 'warning',
  failed: 'danger',
};

function EventRow(props: { event: GithubEvent; first: boolean; deliveries: Delivery[]; titles: Map<string, string>; hasSubscriber: boolean }) {
  const { s, now, theme } = useUi();
  const { event, deliveries, titles } = props;
  const name = (agentId: string) => titles.get(agentId) ?? `会话 ${agentId.slice(0, 8)}`;
  const openUrl = () => {
    if (/^https:\/\//.test(event.url)) void Linking.openURL(event.url).catch(() => undefined);
  };
  return (
    <View style={[s.item, props.first ? s.firstItem : null]}>
      <View style={[s.row, { justifyContent: 'space-between', alignItems: 'flex-start' }]}>
        <Pressable accessibilityRole="link" onPress={openUrl} style={{ flex: 1 }}>
          <View style={s.wrap}>
            <Text style={s.strong}>{eventHeadline(event)}</Text>
            <Chip label={eventTypeText(event)} tone={event.type === 'ci' && event.ci?.failed.length ? 'danger' : 'accent'} />
            <Text style={s.text}>@{event.actor}</Text>
            {event.markerAgentId ? <Chip label={`由 ${name(event.markerAgentId)} 发出`} /> : null}
          </View>
        </Pressable>
        <Text style={s.small}>{ago(event.at, now)}</Text>
      </View>
      {event.title ? (
        <Text style={s.muted} numberOfLines={1}>
          {event.title}
        </Text>
      ) : null}
      <Text style={s.muted} numberOfLines={3}>
        {event.text}
      </Text>
      {deliveries.length > 0 ? (
        <View style={s.wrap}>
          <Text style={s.small}>送达</Text>
          {deliveries.map((delivery) => (
            <Chip key={delivery.id} tone={statusTone[delivery.status]} label={`${name(delivery.agentId)} · ${deliveryStatusLabels[delivery.status]}`} />
          ))}
        </View>
      ) : (
        <Text style={s.small}>{props.hasSubscriber ? '订阅的会话还没有送达记录' : '没有会话订阅，只记录'}</Text>
      )}
      {deliveries.some((delivery) => delivery.error) ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{deliveries.find((delivery) => delivery.error)?.error}</Text>
      ) : null}
    </View>
  );
}

export function EventsTab() {
  const { s } = useUi();
  const { snapshot } = useStoreState();
  const [filter, setFilter] = useState<Filter>('all');
  const [limit, setLimit] = useState(PAGE);

  const rows = useMemo(() => {
    if (!snapshot) return [];
    const titles = new Map<string, string>();
    for (const sub of snapshot.subscriptions) titles.set(sub.agentId, sessionTitle(sub));
    const byEvent = new Map<string, Delivery[]>();
    for (const delivery of snapshot.deliveries) {
      for (const id of delivery.eventIds) byEvent.set(id, [...(byEvent.get(id) ?? []), delivery]);
    }
    return [...snapshot.events]
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .map((event) => ({
        event,
        deliveries: byEvent.get(event.id) ?? [],
        hasSubscriber: snapshot.subscriptions.some((sub) => eventMatchesSubscription(event, sub)),
        titles,
      }));
  }, [snapshot]);

  if (!snapshot) return <Text style={s.muted}>正在读取事件…</Text>;
  const shown = rows.filter((row) => {
    switch (filter) {
      case 'filtered':
        return Boolean(row.event.markerAgentId) || row.deliveries.some((d) => d.status === 'skipped' || d.status === 'shadow');
      case 'bad':
        return row.deliveries.some((d) => d.status === 'failed' || d.status === 'unknown');
      case 'none':
        return row.deliveries.length === 0 && !row.hasSubscriber;
      default:
        return true;
    }
  });
  return (
    <View style={{ gap: 12 }}>
      <View style={[s.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}>
        <Segmented
          value={filter}
          onChange={(value) => {
            setFilter(value);
            setLimit(PAGE);
          }}
          options={[
            { value: 'all', label: '全部' },
            { value: 'filtered', label: '有过滤' },
            { value: 'bad', label: '送达异常' },
            { value: 'none', label: '无人订阅' },
          ]}
        />
        <Text style={s.muted}>共 {rows.length} 条</Text>
      </View>
      {shown.length === 0 ? (
        <Card>
          <Text style={s.muted}>{rows.length === 0 ? '还没有事件。订阅的 Issue、PR 或仓库有新动态后会出现在这里。' : '没有符合筛选条件的事件。'}</Text>
        </Card>
      ) : (
        <Card flush>
          {shown.slice(0, limit).map((row, index) => (
            <EventRow key={row.event.id} first={index === 0} {...row} />
          ))}
          {shown.length > limit ? (
            <Pressable accessibilityRole="button" onPress={() => setLimit(limit + PAGE)} style={[s.item, { alignItems: 'center' }]}>
              <Text style={s.muted}>显示更多（还有 {shown.length - limit} 条）</Text>
            </Pressable>
          ) : null}
        </Card>
      )}
    </View>
  );
}
