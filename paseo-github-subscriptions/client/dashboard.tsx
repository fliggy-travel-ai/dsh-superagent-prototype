import type { PluginScreenProps, PluginSurfaceProps } from '@getpaseo/plugin/client';
import { useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import type { TodoItem, TodoType } from '../shared/todo.ts';
import { DrawerOverlay, type DrawerId } from './drawers.tsx';
import { ago, deliveryStatusLabels, eventHeadline, eventTypesText, eventTypeText, sessionTitle, targetLabel } from './format.ts';
import { AdsPowerKeyCard, SettingsScreen } from './settings/index.tsx';
import { computeHasAlert, computeTodoCount, setLastNonTodoPage } from './sidebar-state.ts';
import { errorMessage } from './store.ts';
import { Btn, Card, Chip, FeatureCard, Notice, Segmented, useControlState, useStoreState, useUi } from './ui.tsx';

export { AdsPowerKeyCard };

export type PageId = 'providers' | 'answer' | 'github' | 'todo';

const NAV_ITEMS: readonly { id: PageId; num: string; label: string }[] = [
  { id: 'providers', num: '1', label: 'Provider 与账号' },
  { id: 'answer', num: '2', label: '问题答复' },
  { id: 'github', num: '3', label: 'GitHub 订阅' },
  { id: 'todo', num: '4', label: '待办总览' },
];

function ProvidersPage({ onOpenDrawer }: { onOpenDrawer(id: DrawerId): void }) {
  const { s, control, theme } = useUi();
  const {
    browser,
    defaults,
    providerInstance,
    cloudSession,
    claudeAccounts,
    claudeAccountsStatus,
    antigravity,
    antigravityStatus,
    machineSettings,
    automation,
    todo,
  } = useControlState();

  const pausedAll = machineSettings?.pausedAll ?? automation?.paused ?? false;
  const accounts = claudeAccounts?.accounts ?? [];
  const reloginAccounts = accounts.filter(acc => acc.needsRelogin);
  const lowestClaudePct = claudeAccounts?.quotaName.lowestRemainingPct ?? null;
  const remoteAttention = (todo?.hosts ?? []).find(h => h.accountsNeedingAttention > 0);

  const browserSettings = browser?.settings ?? { enabled: true, port: 17373 };
  const browserEnvCount =
    browser?.instances?.length ??
    new Set((browser?.sessions ?? []).map(sess => sess.instanceId)).size;
  const rulesCount = defaults?.rules?.length ?? 5;
  const instanceRunning = providerInstance
    ? providerInstance.instanceState === 'running' || providerInstance.instanceState === 'legacy'
    : true;
  const runningSessions = providerInstance?.runningSessionsCount ?? 0;
  const cloudOnline = cloudSession?.onlineSessions ?? providerInstance?.cloudSession.onlineSessions ?? 0;
  const agCount = antigravity?.accounts.length ?? 0;

  return (
    <View style={{ gap: 14 }}>
      <View style={[s.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}>
        <Text style={s.h1}>Provider 与账号</Text>
        <Btn
          danger={!pausedAll}
          primary={pausedAll}
          label={pausedAll ? '恢复自动化' : '暂停全部自动化'}
          onPress={() => void control.pauseAll(!pausedAll)}
        />
      </View>

      {reloginAccounts.map(acc => (
        <Notice key={acc.providerId} tone="danger">
          <View style={[s.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}>
            <Text style={s.text}>
              <Text style={s.strong}>{acc.label}</Text>（{acc.email ?? '本机账号'}）需要重新登录
            </Text>
            <Btn small primary label="重新登录" onPress={() => onOpenDrawer('add-claude')} />
          </View>
        </Notice>
      ))}

      {remoteAttention ? (
        <Notice tone="warning">
          <Text style={s.text}>
            {remoteAttention.hostName} 有 {remoteAttention.accountsNeedingAttention} 个账号需要处理
          </Text>
        </Notice>
      ) : null}

      {providerInstance && !instanceRunning ? (
        <Notice tone="danger">
          <View style={[s.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}>
            <Text style={s.text}>本机 Provider 实例没有运行，云端会话已断开。</Text>
            <Btn small label="查看" onPress={() => onOpenDrawer('provider-instance')} />
          </View>
        </Notice>
      ) : null}

      <View style={[s.wrap, { alignItems: 'stretch', gap: 10 }]}>
        <FeatureCard
          title="Claude 账号"
          trailing={<Btn small primary label="添加账号" onPress={() => onOpenDrawer('add-claude')} />}
          description="添加本机 Claude 账号，查看登录状态并改名。"
          kv={
            claudeAccountsStatus === 'disabled' ? (
              <>
                <Chip label="未启用" tone="neutral" />
                <Text style={s.small}>等待模块启用</Text>
              </>
            ) : (
              <>
                <Text style={s.small}>{accounts.length} 个账号</Text>
                {reloginAccounts.length > 0 ? (
                  <Chip label={`${reloginAccounts.length} 个需要重新登录`} tone="danger" />
                ) : (
                  <Chip label="正常" tone="success" />
                )}
              </>
            )
          }
          actions={<Btn small label="编辑" onPress={() => onOpenDrawer('claude-accounts')} />}
        />

        <FeatureCard
          title="网页版 claude.ai"
          trailing={
            <Switch
              accessibilityLabel="启用网页版 claude.ai"
              value={browserSettings.enabled}
              onValueChange={enabled => void control.configureBrowser({ ...browserSettings, enabled })}
              trackColor={{ true: theme.colors.accent, false: theme.colors.border }}
              thumbColor={theme.colors.accentForeground}
            />
          }
          description="连接 AdsPower 浏览器扩展，自动点击 Allow once 并把网页提问转到 Paseo。"
          kv={
            <>
              <Text style={s.small}>{browserEnvCount} 个浏览器环境</Text>
              <Chip
                label={browser?.connected ? '已连接' : '未连接'}
                tone={browser?.connected ? 'success' : 'neutral'}
              />
            </>
          }
          actions={
            <>
              <Btn small label="添加浏览器环境" onPress={() => onOpenDrawer('add-browser')} />
              <Btn small label="编辑" onPress={() => onOpenDrawer('browser')} />
            </>
          }
        />

        <FeatureCard
          title="Claude 名称带额度"
          trailing={
            <Switch
              accessibilityLabel="Claude 名称带额度"
              value={claudeAccounts?.quotaName.enabled ?? true}
              onValueChange={labelWithQuota =>
                void control.configureClaudeAccounts({ labelWithQuota }).catch(() => {})
              }
              trackColor={{ true: theme.colors.accent, false: theme.colors.border }}
              thumbColor={theme.colors.accentForeground}
            />
          }
          description="在会话的 Claude 名称后显示 5 小时与 7 天剩余百分比。"
          kv={
            claudeAccountsStatus === 'disabled' ? (
              <Chip label="未启用" tone="neutral" />
            ) : (
              <Text style={s.small}>
                {lowestClaudePct !== null ? `当前最低 ${lowestClaudePct}%` : '按账号显示 5h / 7d 额度'}
              </Text>
            )
          }
          actions={<Btn small label="编辑" onPress={() => onOpenDrawer('claude-quota')} />}
        />

        <FeatureCard
          title="新建会话默认设置"
          trailing={
            <Switch
              accessibilityLabel="新建会话默认设置"
              value={defaults?.enabled ?? true}
              onValueChange={enabled => void control.saveDefaults({ enabled }).catch(() => {})}
              trackColor={{ true: theme.colors.accent, false: theme.colors.border }}
              thumbColor={theme.colors.accentForeground}
            />
          }
          description="网页没有指定模式、思考强度或自动授权时，按本机规则填入。"
          kv={<Text style={s.small}>{rulesCount} 条规则</Text>}
          actions={<Btn small label="编辑" onPress={() => onOpenDrawer('session-defaults')} />}
        />

        <FeatureCard
          title="Provider 实例"
          trailing={
            <Chip
              label={instanceRunning ? '运行中' : '未运行'}
              tone={instanceRunning ? 'success' : 'danger'}
            />
          }
          description="独立守护进程，重载本插件时不会中断正在运行的会话。"
          kv={<Text style={s.small}>{runningSessions} 个会话正在运行</Text>}
          actions={<Btn small label="编辑" onPress={() => onOpenDrawer('provider-instance')} />}
        />

        <FeatureCard
          title="云端会话"
          trailing={
            <Switch
              accessibilityLabel="云端会话"
              value={cloudSession?.enabled ?? true}
              onValueChange={() => onOpenDrawer('cloud')}
              trackColor={{ true: theme.colors.accent, false: theme.colors.border }}
              thumbColor={theme.colors.accentForeground}
            />
          }
          description="把飞猪云端开发环境里的会话接入 Paseo。"
          kv={<Text style={s.small}>{cloudOnline} 个在线</Text>}
          actions={<Btn small label="编辑" onPress={() => onOpenDrawer('cloud')} />}
        />

        <FeatureCard
          title="Antigravity"
          trailing={
            <Chip
              label={antigravityStatus === 'disabled' ? '未启用' : '运行中'}
              tone={antigravityStatus === 'disabled' ? 'neutral' : 'success'}
            />
          }
          description="多账号轮换与模型剩余额度。"
          kv={
            antigravityStatus === 'disabled' ? (
              <>
                <Chip label="未启用" tone="neutral" />
                <Text style={s.small}>等待模块启用</Text>
              </>
            ) : (
              <Text style={s.small}>{agCount} 个账号</Text>
            )
          }
          actions={<Btn small label="编辑" onPress={() => onOpenDrawer('antigravity')} />}
        />
      </View>
    </View>
  );
}

function AnswerPage({ onOpenDrawer }: { onOpenDrawer(id: DrawerId): void }) {
  const { s, control, theme } = useUi();
  const {
    presence,
    automation,
    escalation,
    escalationStatus,
    escalationError,
    quiet,
    quietStatus,
  } = useControlState();

  const settings = presence?.settings ?? { mode: 'auto', paused: false, speechEnabled: true, sourceHostId: null };
  const observedMode = presence?.observation.mode ?? 'online';
  const effectiveOnline = settings.mode === 'online' || (settings.mode === 'auto' && observedMode !== 'offline');
  const policiesCount = automation?.policies.filter(p => p.enabled).length ?? 0;
  const pinnedCount = quiet?.pinnedWorkspaceCount ?? 3;

  return (
    <View style={{ gap: 14 }}>
      <View style={{ gap: 4 }}>
        <Text style={s.h1}>问题答复</Text>
        <Text style={s.muted}>
          代答和升级是两套独立规则：问答模式决定是否代答，时段规则决定是否通知 Grok。同一道题可能先被代答，之后仍被升级。
        </Text>
      </View>

      {escalationError || escalation?.error ? (
        <Notice tone="danger">
          <View style={[s.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}>
            <Text style={s.text}>升级通知异常：{escalationError ?? escalation?.error}</Text>
            <Btn small label="查看" onPress={() => onOpenDrawer('escalation')} />
          </View>
        </Notice>
      ) : null}

      <View style={[s.wrap, { alignItems: 'stretch', gap: 10 }]}>
        <FeatureCard
          title="问答模式"
          trailing={
            <Segmented
              options={[
                { value: 'online', label: '在线' },
                { value: 'offline', label: '离线' },
                { value: 'auto', label: '自动' },
              ]}
              value={settings.mode}
              onChange={mode => void control.configurePresence({ ...settings, mode })}
            />
          }
          description="会话向你提问时，等待本人回答或自动选推荐项。"
          kv={
            <>
              <Chip
                label={effectiveOnline ? '判定在线' : '判定离线'}
                tone={effectiveOnline ? 'success' : 'warning'}
              />
              <Text style={s.small}>
                {settings.mode === 'auto' ? `自动：${presence?.observation.reason ?? '判定在线'}` : settings.mode === 'online' ? '手动在线' : '手动离线'}
              </Text>
            </>
          }
          actions={<Btn small label="编辑" onPress={() => onOpenDrawer('qa-mode')} />}
        />

        <FeatureCard
          title="蓝牙在场判定"
          trailing={
            <Switch
              accessibilityLabel="蓝牙在场判定"
              value={settings.mode === 'auto'}
              onValueChange={auto =>
                void control.configurePresence({ ...settings, mode: auto ? 'auto' : 'online' })
              }
              trackColor={{ true: theme.colors.accent, false: theme.colors.border }}
              thumbColor={theme.colors.accentForeground}
            />
          }
          description="按随身蓝牙设备是否在场，自动切换在线或离线。"
          kv={
            <>
              <Text style={s.small}>{presence?.observation.reason || '随身手机'}</Text>
              <Chip
                label={observedMode === 'offline' ? '离开' : '在线'}
                tone={observedMode === 'offline' ? 'warning' : 'success'}
              />
            </>
          }
          actions={<Btn small label="编辑" onPress={() => onOpenDrawer('bluetooth')} />}
        />

        <FeatureCard
          title="升级通知"
          trailing={
            <Switch
              accessibilityLabel="升级通知"
              value={escalation?.enabled ?? true}
              onValueChange={enabled => void control.configureEscalation({ enabled }).catch(() => {})}
              trackColor={{ true: theme.colors.accent, false: theme.colors.border }}
              thumbColor={theme.colors.accentForeground}
            />
          }
          description="提问超时未答或属于必须本人确认的类别时，通过 Webhook 通知 Grok。"
          kv={
            escalationStatus === 'disabled' ? (
              <>
                <Chip label="未启用" tone="neutral" />
                <Text style={s.small}>等待模块启用</Text>
              </>
            ) : (
              <>
                <Chip label="运行中" tone="success" />
                <Text style={s.small}>{escalation?.delivery === 'shadow' ? '影子' : '实际发送'}</Text>
              </>
            )
          }
          actions={<Btn small label="编辑" onPress={() => onOpenDrawer('escalation')} />}
        />

        <FeatureCard
          title="子会话免提醒"
          trailing={
            <Switch
              accessibilityLabel="子会话免提醒"
              value={quiet?.enabled ?? true}
              onValueChange={enabled => void control.configureQuiet({ enabled }).catch(() => {})}
              trackColor={{ true: theme.colors.accent, false: theme.colors.border }}
              thumbColor={theme.colors.accentForeground}
            />
          }
          description="子会话和未置顶工作区的会话不直接提醒你，异常归并到主会话。"
          kv={
            quietStatus === 'disabled' ? (
              <>
                <Chip label="未启用" tone="neutral" />
                <Text style={s.small}>等待模块启用</Text>
              </>
            ) : (
              <Text style={s.small}>主会话：{pinnedCount} 个置顶工作区</Text>
            )
          }
          actions={<Btn small label="编辑" onPress={() => onOpenDrawer('quiet-children')} />}
        />

        <FeatureCard
          title="语音提醒"
          trailing={
            <Switch
              accessibilityLabel="语音提醒"
              value={settings.speechEnabled}
              onValueChange={speechEnabled => void control.configurePresence({ ...settings, speechEnabled })}
              trackColor={{ true: theme.colors.accent, false: theme.colors.border }}
              thumbColor={theme.colors.accentForeground}
            />
          }
          description="判定在线时，用语音播报新提问和停滞的主会话。"
          kv={<Text style={s.small}>播报主机 {presence?.hostName ?? 'Mac mini'}</Text>}
          actions={<Btn small label="编辑" onPress={() => onOpenDrawer('speech')} />}
        />

        <FeatureCard
          title="精确授权"
          trailing={<Chip label="已配置" tone="neutral" />}
          description="跨重启保留的单会话命令和工作区路径白名单。"
          kv={<Text style={s.small}>{policiesCount} 条策略</Text>}
          actions={<Btn small label="编辑" onPress={() => onOpenDrawer('approval')} />}
        />
      </View>
    </View>
  );
}

function GithubPage({ onOpenDrawer }: { onOpenDrawer(id: DrawerId): void }) {
  const { s, store, openSettings, navigation, now, theme } = useUi();
  const { snapshot, error } = useStoreState();
  const [showEvents, setShowEvents] = useState(false);
  const [busySubId, setBusySubId] = useState<string | null>(null);

  const prefs = snapshot?.preferences ?? {
    enabled: true,
    shadow: false,
    organization: 'fliggy-travel-ai',
    excludedRepos: [],
    extraRepos: [],
    providerPolicies: {},
  };
  const subscriptions = snapshot?.subscriptions ?? [];
  const events = snapshot?.events ?? [];
  const repoCount = snapshot?.repositories.length ?? 0;

  const cancelSub = async (id: string) => {
    setBusySubId(id);
    try {
      await store.unsubscribe(id);
    } finally {
      setBusySubId(null);
    }
  };

  return (
    <View style={{ gap: 14 }}>
      <Text style={s.h1}>GitHub 订阅</Text>

      {snapshot && !snapshot.token.configured ? (
        <Notice tone="warning">
          <View style={[s.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}>
            <Text style={s.text}>未保存 GitHub 令牌，无法轮询事件。</Text>
            {openSettings ? (
              <Btn small label="去设置填写" onPress={() => openSettings('dev-automation')} />
            ) : null}
          </View>
        </Notice>
      ) : null}

      {error || snapshot?.error ? (
        <Notice tone="danger">
          <Text style={s.text}>{error ?? snapshot?.error}</Text>
        </Notice>
      ) : null}

      <View style={[s.wrap, { alignItems: 'stretch', gap: 10 }]}>
        <FeatureCard
          title="监听"
          trailing={
            <Switch
              accessibilityLabel="启用 GitHub 监听"
              value={prefs.enabled}
              onValueChange={enabled => void store.savePreferences({ ...prefs, enabled })}
              trackColor={{ true: theme.colors.accent, false: theme.colors.border }}
              thumbColor={theme.colors.accentForeground}
            />
          }
          description="每 60 秒轮询订阅的仓库和议题，把新事件直接发到对应会话。"
          kv={
            <>
              <Chip
                label={prefs.shadow ? '影子' : '实际发送'}
                tone={prefs.shadow ? 'warning' : 'success'}
              />
              <Text style={s.small}>
                {prefs.organization} · {repoCount} 个仓库
              </Text>
            </>
          }
          actions={<Btn small label="编辑" onPress={() => onOpenDrawer('github-config')} />}
        />
      </View>

      <Card title={`订阅（${subscriptions.length}）`}>
        {subscriptions.length === 0 ? (
          <Text style={s.muted}>当前没有活跃的 GitHub 订阅。</Text>
        ) : (
          subscriptions.map((sub, idx) => (
            <View
              key={sub.id}
              style={[
                s.row,
                {
                  justifyContent: 'space-between',
                  paddingVertical: 10,
                  borderTopWidth: idx === 0 ? 0 : 1,
                  borderTopColor: theme.colors.border,
                  flexWrap: 'wrap',
                },
              ]}
            >
              <View style={{ flex: 1, gap: 2, minWidth: 180 }}>
                <View style={s.wrap}>
                  <Text style={s.mono}>{targetLabel(sub)}</Text>
                  <Text style={s.text}>{sub.title ?? '整个仓库'}</Text>
                </View>
                <View style={s.wrap}>
                  <Pressable
                    onPress={() => navigation?.openAgent({ agentId: sub.agentId })}
                  >
                    <Text style={{ color: theme.colors.accent, fontSize: 12 }}>
                      {sessionTitle(sub)}
                    </Text>
                  </Pressable>
                  <Text style={s.small}>· {eventTypesText(sub.events).join('、')}</Text>
                  <Text style={s.small}>· 最近 {ago(sub.lastEventAt, now)}</Text>
                </View>
              </View>
              <Btn
                small
                danger
                label="取消订阅"
                busy={busySubId === sub.id}
                onPress={() => void cancelSub(sub.id)}
              />
            </View>
          ))
        )}
      </Card>

      <Card
        title={`最近事件（${Math.min(events.length, 20)}）`}
        trailing={
          <Btn
            small
            label={showEvents ? '收起' : '展开'}
            onPress={() => setShowEvents(prev => !prev)}
          />
        }
      >
        {!showEvents ? (
          <Text style={s.muted}>点击“展开”查看最近轮询到的 GitHub 事件及投递结果。</Text>
        ) : events.length === 0 ? (
          <Text style={s.muted}>暂无最近事件。</Text>
        ) : (
          events.slice(0, 20).map((ev, idx) => {
            const firstDelivery = (snapshot?.deliveries ?? []).find(d => d.eventIds.includes(ev.id));
            return (
              <View
                key={ev.id}
                style={[
                  s.row,
                  {
                    justifyContent: 'space-between',
                    paddingVertical: 8,
                    borderTopWidth: idx === 0 ? 0 : 1,
                    borderTopColor: theme.colors.border,
                    flexWrap: 'wrap',
                  },
                ]}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={s.wrap}>
                    <Text style={s.mono}>{eventHeadline(ev)}</Text>
                    <Chip label={eventTypeText(ev)} tone="neutral" />
                    <Text style={s.small}>{ago(ev.at, now)}</Text>
                  </View>
                  <Text style={s.small}>{ev.title ?? ev.text}</Text>
                </View>
                {firstDelivery ? (
                  <Chip
                    label={deliveryStatusLabels[firstDelivery.status]}
                    tone={
                      firstDelivery.status === 'delivered'
                        ? 'success'
                        : firstDelivery.status === 'failed'
                          ? 'danger'
                          : 'neutral'
                    }
                  />
                ) : null}
              </View>
            );
          })
        )}
      </Card>
    </View>
  );
}

function TodoItemCard({ item }: { item: TodoItem }) {
  const { s, control, navigation, theme } = useUi();
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prompts = item.question?.prompts ?? [];

  const toggleChoice = (question: string, label: string, multi: boolean) => {
    setSelected(prev => {
      const current = prev[question] ?? [];
      if (!multi) return { ...prev, [question]: [label] };
      return {
        ...prev,
        [question]: current.includes(label) ? current.filter(x => x !== label) : [...current, label],
      };
    });
  };

  const submitAnswer = async () => {
    if (!item.question) return;
    setBusy(true);
    setError(null);
    try {
      const answers: Record<string, string[]> = {};
      const otherAnswers: Record<string, string> = {};
      for (const p of prompts) {
        const picks = [...(selected[p.question] ?? [])];
        const custom = (otherText[p.question] ?? '').trim();
        if (custom) otherAnswers[p.question] = custom;
        if (picks.length === 0 && !custom && p.options[0]) picks.push(p.options[0].label);
        answers[p.question] = picks;
      }
      await control.actTodo({
        hostId: item.hostId,
        action: {
          type: 'answer',
          questionId: item.question.questionId,
          answers,
          ...(Object.keys(otherAnswers).length > 0 ? { otherAnswers } : {}),
        },
      });
      setExpanded(false);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const markRead = async () => {
    if (!item.readReceipt) return;
    setBusy(true);
    setError(null);
    try {
      await control.actTodo({
        hostId: item.hostId,
        action: {
          type: 'read',
          questionId: item.readReceipt.questionId,
          fingerprint: item.readReceipt.fingerprint,
        },
      });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const ackEscalation = async () => {
    if (!item.escalationId) return;
    setBusy(true);
    setError(null);
    try {
      await control.actTodo({
        hostId: item.hostId,
        action: {
          type: 'ack-escalation',
          escalationId: item.escalationId,
          agentId: item.agentId,
        },
      });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const badgeTone =
    item.type === 'ask' || item.type === 'esc'
      ? 'danger'
      : item.type === 'web' || item.type === 'stall'
        ? 'warning'
        : 'neutral';

  return (
    <View
      style={[
        s.card,
        {
          padding: 14,
          gap: 10,
        },
      ]}
    >
      <View style={[s.row, { justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap' }]}>
        <View style={[s.row, { alignItems: 'flex-start', flex: 1, minWidth: 220, gap: 10 }]}>
          <Chip label={item.label} tone={badgeTone} />
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={s.strong}>{item.text}</Text>
            <Text style={s.small}>
              {item.sessionTitle} · {item.sourceLabel} · {item.hostName} · {item.ageText}
            </Text>
          </View>
        </View>

        <View style={s.row}>
          {item.type === 'ask' ? (
            <>
              <Btn
                small
                primary
                label={expanded ? '收起' : '回答'}
                onPress={() => setExpanded(prev => !prev)}
              />
              {item.url ? (
                <Btn small label="打开原网页" onPress={() => void Linking.openURL(item.url!)} />
              ) : null}
            </>
          ) : item.type === 'esc' ? (
            <>
              <Btn small primary label="标为已处理" busy={busy} onPress={() => void ackEscalation()} />
              {item.agentId ? (
                <Btn
                  small
                  label="打开会话"
                  onPress={() => navigation?.openAgent({ agentId: item.agentId! })}
                />
              ) : null}
            </>
          ) : item.type === 'web' ? (
            <Btn
              small
              primary
              label="打开原网页"
              onPress={() => {
                if (item.url) void Linking.openURL(item.url);
              }}
            />
          ) : item.type === 'stall' ? (
            <Btn
              small
              primary
              label="打开会话"
              onPress={() => {
                if (item.agentId) navigation?.openAgent({ agentId: item.agentId });
              }}
            />
          ) : (
            <Btn small label="已读" busy={busy} onPress={() => void markRead()} />
          )}
        </View>
      </View>

      {expanded && item.type === 'ask' ? (
        <View
          style={{
            paddingTop: 10,
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
            gap: 10,
          }}
        >
          {prompts.map(p => {
            const current = selected[p.question] ?? [];
            return (
              <View key={p.question} style={{ gap: 6 }}>
                <Text style={s.strong}>{p.question}</Text>
                <View style={s.wrap}>
                  {p.options.map(opt => {
                    const active = current.includes(opt.label);
                    return (
                      <Btn
                        key={opt.label}
                        small
                        primary={active}
                        label={opt.label}
                        onPress={() => toggleChoice(p.question, opt.label, p.multiSelect)}
                      />
                    );
                  })}
                </View>
                {p.allowOther ? (
                  <TextInput
                    accessibilityLabel={`其他回答 ${p.question}`}
                    style={s.input}
                    value={otherText[p.question] ?? ''}
                    onChangeText={val => setOtherText(prev => ({ ...prev, [p.question]: val }))}
                    placeholder="其他回答（可选）"
                    placeholderTextColor={theme.colors.foregroundMuted}
                  />
                ) : null}
              </View>
            );
          })}
          {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}
          <View style={s.row}>
            <Btn primary label="提交回答" busy={busy} onPress={() => void submitAnswer()} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function TodoPage() {
  const { s, now, theme } = useUi();
  const { todo, todoError } = useControlState();
  const [subtab, setSubtab] = useState<'list' | 'log'>('list');
  const [filter, setFilter] = useState<'all' | TodoType>('all');

  const items = todo?.items ?? [];
  const logs = todo?.logs ?? [];
  const countByType = (t: TodoType) => items.filter(i => i.type === t).length;

  const visibleItems = filter === 'all' ? items : items.filter(item => item.type === filter);

  return (
    <View style={{ gap: 14 }}>
      <View style={[s.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}>
        <Text style={s.h1}>待办总览</Text>
        <Segmented
          options={[
            { value: 'list', label: `待办 (${items.length})` },
            { value: 'log', label: '处理记录' },
          ]}
          value={subtab}
          onChange={setSubtab}
        />
      </View>

      {todo?.warning ? (
        <Notice tone="warning">
          <Text style={s.text}>{todo.warning}</Text>
        </Notice>
      ) : null}

      {todoError ? (
        <Notice tone="danger">
          <Text style={s.text}>{todoError}</Text>
        </Notice>
      ) : null}

      {subtab === 'list' ? (
        <>
          <View style={s.wrap}>
            {(
              [
                ['all', `全部 ${items.length}`],
                ['ask', `网页提问 ${countByType('ask')}`],
                ['web', `网页等待 ${countByType('web')}`],
                ['stall', `停滞会话 ${countByType('stall')}`],
                ['esc', `升级事件 ${countByType('esc')}`],
                ['read', `代答未读 ${countByType('read')}`],
              ] as const
            ).map(([key, label]) => (
              <Btn
                key={key}
                small
                primary={filter === key}
                label={label}
                onPress={() => setFilter(key)}
              />
            ))}
          </View>

          <View style={{ gap: 8 }}>
            {visibleItems.length === 0 ? (
              <Card>
                <Text style={s.muted}>当前没有需要处理的插件待办项。</Text>
              </Card>
            ) : (
              visibleItems.map(item => <TodoItemCard key={item.id} item={item} />)
            )}
          </View>
        </>
      ) : (
        <Card title="最近自动处理记录">
          {logs.length === 0 ? (
            <Text style={s.muted}>暂无自动处理记录。</Text>
          ) : (
            logs.map((log, idx) => (
              <View
                key={log.id}
                style={[
                  s.row,
                  {
                    justifyContent: 'space-between',
                    paddingVertical: 8,
                    borderTopWidth: idx === 0 ? 0 : 1,
                    borderTopColor: theme.colors.border,
                    flexWrap: 'wrap',
                  },
                ]}
              >
                <View style={s.wrap}>
                  <Text style={s.mono}>{ago(log.at, now)}</Text>
                  <Chip label={log.label} tone="neutral" />
                  <Text style={s.small}>{log.hostName}</Text>
                </View>
                <Text style={[s.text, { flex: 1, minWidth: 200 }]}>{log.detail}</Text>
              </View>
            ))
          )}
        </Card>
      )}
    </View>
  );
}

export function MainScreen(props: PluginScreenProps) {
  const { s, theme, compact, openSettings } = useUi();
  const storeState = useStoreState();
  const controlState = useControlState();

  const paramPage = props.params?.page as PageId | undefined;
  const paramDrawer = props.params?.drawer as DrawerId | undefined;

  const [page, setPage] = useState<PageId>(() =>
    paramPage && ['providers', 'answer', 'github', 'todo'].includes(paramPage) ? paramPage : 'providers',
  );
  const [drawer, setDrawer] = useState<DrawerId | null>(() => paramDrawer ?? null);

  useEffect(() => {
    if (paramPage && ['providers', 'answer', 'github', 'todo'].includes(paramPage)) {
      setPage(paramPage);
      setLastNonTodoPage(paramPage);
    }
  }, [paramPage]);

  useEffect(() => {
    if (paramDrawer !== undefined) {
      setDrawer(paramDrawer || null);
    }
  }, [paramDrawer]);

  const selectPage = (next: PageId) => {
    setPage(next);
    setLastNonTodoPage(next);
  };

  const hasAlert = computeHasAlert(storeState, controlState);
  const todoCount = computeTodoCount(controlState);

  return (
    <View style={[s.page, { flexDirection: compact ? 'column' : 'row', position: 'relative' }]}>
      <View
        style={{
          width: compact ? '100%' : 196,
          backgroundColor: theme.colors.surface1,
          borderRightWidth: compact ? 0 : 1,
          borderBottomWidth: compact ? 1 : 0,
          borderColor: theme.colors.border,
          padding: 12,
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <View style={{ gap: 4 }}>
          <Text style={[s.strong, { paddingHorizontal: 8, paddingVertical: 6 }]}>开发自动化</Text>
          <View style={{ flexDirection: compact ? 'row' : 'column', flexWrap: 'wrap', gap: 4 }}>
            {NAV_ITEMS.map(item => {
              const active = page === item.id;
              return (
                <Pressable
                  key={item.id}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={item.label}
                  onPress={() => selectPage(item.id)}
                  style={[
                    s.row,
                    {
                      justifyContent: 'space-between',
                      paddingHorizontal: 10,
                      paddingVertical: 8,
                      borderRadius: 8,
                      backgroundColor: active ? theme.colors.surface2 : 'transparent',
                    },
                  ]}
                >
                  <View style={s.row}>
                    <Text style={[s.mono, { fontSize: 11, color: theme.colors.foregroundMuted }]}>{item.num}</Text>
                    <Text
                      style={{
                        color: active ? theme.colors.foreground : theme.colors.foregroundMuted,
                        fontSize: 13,
                        fontWeight: active ? '600' : '400',
                      }}
                    >
                      {item.label}
                    </Text>
                  </View>
                  {item.id === 'providers' && hasAlert ? (
                    <Text style={{ color: theme.colors.statusDanger, fontSize: 12, fontWeight: '700' }}>!</Text>
                  ) : null}
                  {item.id === 'todo' && todoCount > 0 ? (
                    <Text style={{ color: theme.colors.statusWarning, fontSize: 12, fontWeight: '600' }}>
                      {todoCount}
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </View>

        {!compact ? (
          <View
            style={{
              paddingTop: 10,
              borderTopWidth: 1,
              borderTopColor: theme.colors.border,
              gap: 6,
            }}
          >
            <Text style={s.small}>
              启停 Provider、模型、额度在 Paseo 设置和额度面板。令牌和 API key 在 设置 → 开发自动化。
            </Text>
            {openSettings ? (
              <Pressable onPress={() => openSettings('dev-automation')}>
                <Text style={{ color: theme.colors.accent, fontSize: 12 }}>打开设置 → 开发自动化 ›</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={[s.pageContent, { maxWidth: 980 }]}>
        {page === 'providers' ? <ProvidersPage onOpenDrawer={setDrawer} /> : null}
        {page === 'answer' ? <AnswerPage onOpenDrawer={setDrawer} /> : null}
        {page === 'github' ? <GithubPage onOpenDrawer={setDrawer} /> : null}
        {page === 'todo' ? <TodoPage /> : null}
      </ScrollView>

      <DrawerOverlay drawerId={drawer} onClose={() => setDrawer(null)} onOpenDrawer={setDrawer} />
    </View>
  );
}

export function UsageSettingsScreen(props: PluginSurfaceProps) {
  return <SettingsScreen {...props} />;
}
