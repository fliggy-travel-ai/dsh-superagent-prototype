import { useToast } from '@getpaseo/plugin/client/ui';
import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import type { Subscription } from '../../shared/model.ts';
import { ago, eventTypesText, sessionTitle, targetLabel } from '../format.ts';
import { errorMessage } from '../store.ts';
import { Btn, Card, Chip, Segmented, useStoreState, useUi } from '../ui.tsx';

type Grouping = 'repo' | 'session';

function SubRow(props: { sub: Subscription; first: boolean; indent: boolean; showSession: boolean }) {
  const { s, store, navigation, now, theme, compact } = useUi();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { sub } = props;
  const title = sessionTitle(sub);
  const delivery = sub.lastDelivery;
  const deliveryText = !delivery ? '暂无事件' : delivery.ok ? '已送达' : `送达失败${delivery.error ? `：${delivery.error}` : ''}`;
  const deliveryColor = !delivery ? theme.colors.foregroundMuted : delivery.ok ? theme.colors.statusSuccess : theme.colors.statusDanger;

  const cancel = async () => {
    setBusy(true);
    try {
      await store.unsubscribe(sub.id);
    } catch (failure) {
      toast.error(`取消订阅失败：${errorMessage(failure)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[s.item, props.first ? s.firstItem : null, { flexDirection: compact ? 'column' : 'row', alignItems: compact ? 'stretch' : 'center', gap: compact ? 6 : 12 }]}>
      <View style={{ flex: 2, gap: 2, minWidth: 0, paddingLeft: props.indent ? 16 : 0 }}>
        {props.showSession ? (
          <>
            <Text style={s.strong} numberOfLines={1}>
              {props.indent ? '└ ' : ''}
              {title}
            </Text>
          </>
        ) : (
          <Text style={s.strong} numberOfLines={1}>
            {targetLabel(sub)}
          </Text>
        )}
      </View>
      <View style={{ flex: 3, gap: 2, minWidth: 0 }}>
        {props.showSession ? (
          <Text style={s.strong} numberOfLines={1}>
            {sub.owner}/{targetLabel(sub)}
          </Text>
        ) : null}
        <Text style={s.muted} numberOfLines={compact ? 2 : 1}>
          {sub.number ? sub.title ?? '' : '整个仓库'}
        </Text>
        <View style={s.wrap}>
          {eventTypesText(sub.events).map((label) => (
            <Chip key={label} label={label} />
          ))}
        </View>
      </View>
      <View style={{ flex: 2, gap: 2, minWidth: 0 }}>
        <Text style={s.text}>{ago(sub.lastEventAt, now)}</Text>
        <Text style={{ color: deliveryColor, fontSize: 12 }}>{deliveryText}</Text>
      </View>
      <View style={s.row}>
        {navigation ? <Btn small label="打开会话" onPress={() => navigation.openAgent({ agentId: sub.agentId })} /> : null}
        <Btn small danger label="取消订阅" busy={busy} onPress={() => void cancel()} />
      </View>
    </View>
  );
}

function sortSessions(subs: Subscription[]): { agentId: string; indent: boolean; items: Subscription[] }[] {
  const byAgent = new Map<string, Subscription[]>();
  for (const sub of subs) byAgent.set(sub.agentId, [...(byAgent.get(sub.agentId) ?? []), sub]);
  const parentOf = (agentId: string) => {
    const parent = byAgent.get(agentId)?.[0]?.parentAgentId ?? null;
    return parent && byAgent.has(parent) && parent !== agentId ? parent : null;
  };
  const roots = [...byAgent.keys()].filter((id) => parentOf(id) === null);
  const ordered: { agentId: string; indent: boolean; items: Subscription[] }[] = [];
  const seen = new Set<string>();
  const visit = (id: string, indent: boolean) => {
    if (seen.has(id)) return;
    seen.add(id);
    ordered.push({ agentId: id, indent, items: byAgent.get(id) ?? [] });
    for (const child of byAgent.keys()) if (parentOf(child) === id) visit(child, true);
  };
  for (const root of roots) visit(root, false);
  for (const id of byAgent.keys()) visit(id, false);
  return ordered;
}

export function SubscriptionsTab() {
  const { s } = useUi();
  const { snapshot } = useStoreState();
  const [grouping, setGrouping] = useState<Grouping>('repo');
  const subs = snapshot?.subscriptions ?? [];

  const groups = useMemo(() => {
    if (grouping === 'repo') {
      const byRepo = new Map<string, Subscription[]>();
      for (const sub of subs) byRepo.set(sub.repo, [...(byRepo.get(sub.repo) ?? []), sub]);
      return [...byRepo].map(([repo, items]) => ({
        key: repo,
        title: repo,
        rows: items.map((sub) => ({ sub, indent: false })),
      }));
    }
    return sortSessions(subs).map((session) => ({
      key: session.agentId,
      title: sessionTitle(session.items[0]),
      rows: session.items.map((sub) => ({ sub, indent: session.indent })),
    }));
  }, [grouping, subs]);

  if (!snapshot) return <Text style={s.muted}>正在读取订阅…</Text>;
  if (subs.length === 0) {
    return (
      <Card>
        <Text style={s.strong}>还没有会话订阅</Text>
        <Text style={s.muted}>会话可以用工具订阅 Issue、PR 或整个仓库。有新评论、Review、新提交、CI 结果或合并/关闭时，插件会把消息发到该会话。</Text>
      </Card>
    );
  }
  const sessions = new Set(subs.map((sub) => sub.agentId)).size;
  return (
    <View style={{ gap: 12 }}>
      <View style={[s.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}>
        <Segmented
          value={grouping}
          onChange={setGrouping}
          options={[
            { value: 'repo', label: '按仓库' },
            { value: 'session', label: '按会话' },
          ]}
        />
        <Text style={s.muted}>
          {sessions} 个会话 · {subs.length} 个订阅
        </Text>
      </View>
      {groups.map((group) => (
        <Card key={group.key} title={group.title} trailing={<Text style={s.muted}>{group.rows.length} 个订阅</Text>} flush>
          {group.rows.map((row, index) => (
            <SubRow key={row.sub.id} sub={row.sub} first={index === 0} indent={row.indent} showSession={grouping === 'repo'} />
          ))}
        </Card>
      ))}
    </View>
  );
}
