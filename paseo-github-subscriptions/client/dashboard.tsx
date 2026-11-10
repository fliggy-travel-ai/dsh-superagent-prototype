import type { PluginScreenProps } from '@getpaseo/plugin/client';
import { useEffect, useState, type ComponentProps } from 'react';
import { Linking, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import type { Question, QuestionAnswer, QuestionPrompt } from '../shared/presence.ts';
import type { TodoItem, TodoType } from '../shared/todo.ts';
import { DrawerOverlay, type DrawerId } from './drawers.tsx';
import { ago } from './format.ts';
import { GitHubSubscriptionsViews } from './screen/index.tsx';
import { computeHasAlert, computeTodoCount, setLastNonTodoPage } from './sidebar-state.ts';
import { errorMessage } from './store.ts';
import { Btn, Card, Chip, FeatureCard, Notice, Segmented, useControlState, useStoreState, useUi } from './ui.tsx';

export interface QuestionDraftState {
  answers: Record<string, string[]>;
  otherAnswers: Record<string, string>;
}

export function pickPromptOption(prompt: QuestionPrompt, current: QuestionDraftState, nextPicked: string[]): QuestionDraftState {
  const answers = { ...current.answers, [prompt.question]: nextPicked };
  const otherAnswers = { ...current.otherAnswers };
  if (!prompt.multiSelect && nextPicked.length > 0) {
    otherAnswers[prompt.question] = '';
  }
  return { answers, otherAnswers };
}

export function changePromptOther(prompt: QuestionPrompt, current: QuestionDraftState, value: string): QuestionDraftState {
  const otherAnswers = { ...current.otherAnswers, [prompt.question]: value };
  const answers = { ...current.answers };
  if (!prompt.multiSelect && value.length > 0) {
    answers[prompt.question] = [];
  }
  return { answers, otherAnswers };
}

export function isPromptComplete(prompt: QuestionPrompt, picked: string[], otherText?: string): boolean {
  const other = (otherText ?? '').trim();
  if (other.length > 0 && (!prompt.allowOther || other.length > 2000)) return false;
  const count = picked.length + (other.length > 0 ? 1 : 0);
  return prompt.multiSelect ? count >= 1 : count === 1;
}

export function isQuestionAnswerable(question: Question): boolean {
  return (question.pages ?? 1) <= 1 && question.prompts.length > 0 && question.prompts.every(prompt => prompt.options.length > 0 || Boolean(prompt.allowOther));
}

export function isQuestionComplete(question: Question, answers: Record<string, string[]>, otherAnswers: Record<string, string>): boolean {
  return isQuestionAnswerable(question) && question.prompts.every(prompt => isPromptComplete(prompt, answers[prompt.question] ?? [], otherAnswers[prompt.question]));
}

export function buildQuestionSubmission(question: Question, answers: Record<string, string[]>, otherAnswers: Record<string, string>): QuestionAnswer {
  const submittedAnswers: Record<string, string[]> = {};
  const submittedOther: Record<string, string> = {};
  for (const prompt of question.prompts) {
    submittedAnswers[prompt.question] = answers[prompt.question] ?? [];
    const trimmed = (otherAnswers[prompt.question] ?? '').trim();
    if (trimmed) submittedOther[prompt.question] = trimmed;
  }
  return {
    id: question.id,
    answers: submittedAnswers,
    ...(Object.keys(submittedOther).length ? { otherAnswers: submittedOther } : {}),
  };
}

export type PageId = 'providers' | 'answer' | 'github' | 'todo';

const NAV_ITEMS: readonly { id: PageId; num: string; label: string }[] = [
  { id: 'providers', num: '1', label: 'Provider 与账号' },
  { id: 'answer', num: '2', label: '问题答复' },
  { id: 'github', num: '3', label: 'GitHub 订阅' },
  { id: 'todo', num: '4', label: '待办总览' },
];

function isModuleOff(
  id: string,
  machineSettings: { modules: ReadonlyArray<{ id: string; enabled: boolean; state: string }> } | null,
  modules: { modules: ReadonlyArray<{ id: string; state: string }> } | null,
): boolean {
  const msMod = machineSettings?.modules.find(m => m.id === id);
  if (msMod) return !msMod.enabled || msMod.state === 'off';
  const liveMod = modules?.modules.find(m => m.id === id);
  if (liveMod) return liveMod.state === 'off';
  return false;
}

function ModuleOffHint() {
  return <Chip label="未启用" tone="neutral" />;
}

function ModuleFeatureCard({ moduleId, label, featureEnabled, ...props }: Omit<ComponentProps<typeof FeatureCard>, 'trailing' | 'notice'> & {
  moduleId: string;
  label: string;
  featureEnabled?: boolean;
}) {
  const { s, control, theme } = useUi();
  const { machineSettings, machineSettingsError, moduleReloading, moduleReloadingId, moduleReloadUnverified } = useControlState();
  const [error, setError] = useState<string | null>(null);
  const item = machineSettings?.modules.find(m => m.id === moduleId);
  return <FeatureCard {...props}
    trailing={<Switch accessibilityLabel={label} disabled={!item || !!machineSettingsError || moduleReloading}
      value={Boolean(item?.enabled && (featureEnabled ?? true))}
      onValueChange={enabled => {
        setError(null);
        void control.toggleModule(moduleId, enabled).catch(e => setError(errorMessage(e)));
      }} trackColor={{ true: theme.colors.accent, false: theme.colors.border }} thumbColor={theme.colors.accentForeground} />}
    notice={moduleReloading && moduleReloadingId === moduleId ? <Text style={s.small}>正在重新加载，约 5 秒后生效</Text> : <>
      {error ? <Text style={s.small}>{error}</Text> : null}
      {moduleReloadUnverified === moduleId || (item && item.state !== (item.enabled ? 'running' : 'off')) ? <Text style={s.small}>已保存，未生效，请手动重载插件</Text> : null}
    </>}
  />;
}

function ProvidersPage({
  onOpenDrawer,
}: {
  onOpenDrawer(id: DrawerId): void;
}) {
  const { s, control, theme } = useUi();
  const {
    browser,
    browserError,
    providerInstance,
    cloudSession,
    cloudSessionError,
    claudeAccounts,
    claudeAccountsStatus,
    machineSettings,
    machineSettingsError,
    moduleReloading,
    modules,
    todo,
  } = useControlState();
  const [actionError, setActionError] = useState<string | null>(null);
  const [pauseBusy, setPauseBusy] = useState(false);
  const pausedAll = machineSettings?.pausedAll ?? false;
  const claudeAccountsDisabled =
    isModuleOff('usage.claudeAccounts', machineSettings, modules) ||
    claudeAccountsStatus === 'disabled' ||
    Boolean(claudeAccounts && !claudeAccounts.enabled);
  const browserModOff = isModuleOff('answer.browser', machineSettings, modules);
  const accounts = claudeAccounts?.accounts ?? [];
  const reloginAccounts = claudeAccountsDisabled ? [] : accounts.filter(acc => acc.needsRelogin);
  const remoteAttention = (todo?.hosts ?? []).find(h => h.accountsNeedingAttention > 0);

  const browserEnvCount =
    browser?.instances?.length ??
    new Set((browser?.sessions ?? []).map(sess => sess.instanceId)).size;
  const instanceRunning = providerInstance
    ? providerInstance.instanceState === 'running' || providerInstance.instanceState === 'legacy'
    : false;
  const resolvedCloud = cloudSession ?? providerInstance?.cloudSession ?? null;

  return (
    <View style={{ gap: 14 }}>
      <View style={[s.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}>
        <Text style={s.h1}>Provider 与账号</Text>
        <Btn
          danger={!pausedAll}
          primary={pausedAll}
          disabled={moduleReloading || !machineSettings || Boolean(machineSettingsError)}
          busy={pauseBusy}
          label={pausedAll ? '恢复自动化' : '暂停全部自动化'}
          onPress={() => {
            if (!machineSettings || machineSettingsError || pauseBusy) return;
            setActionError(null);
            setPauseBusy(true);
            void control
              .pauseAll(!pausedAll)
              .catch(e => setActionError(errorMessage(e)))
              .finally(() => setPauseBusy(false));
          }}
        />
      </View>

      {actionError ? (
        <Notice tone="danger">
          <Text style={s.text}>{actionError}</Text>
        </Notice>
      ) : null}

      {reloginAccounts.map(acc => (
        <Notice key={acc.providerId} tone="danger">
          <View style={[s.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}>
            <Text style={s.text}>
              <Text style={s.strong}>{acc.label}</Text>（{acc.email ?? '本机账号'}）需要重新登录
            </Text>
            <Text style={s.small}>请在 Paseo 的 Provider 设置中重新登录</Text>
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
          <Text style={s.text}>本机 Provider 实例没有运行，云端会话已断开。</Text>
        </Notice>
      ) : null}

      <View style={[s.wrap, { alignItems: 'stretch', gap: 10 }]}>
        <ModuleFeatureCard
          title="网页版 claude.ai"
          moduleId="answer.browser"
          label="启用网页版 claude.ai"
          featureEnabled={browser?.settings.enabled}
          description="连接 AdsPower 浏览器扩展，自动点击 Allow once 并把网页提问转到 Paseo。"
          kv={
            browserModOff ? (
              <ModuleOffHint />
            ) : browserError ? (
              <>
                <Chip label="读取失败" tone="danger" />
                <Text style={s.small}>读取失败：{browserError}</Text>
              </>
            ) : !browser ? (
              <Text style={s.small}>正在读取…</Text>
            ) : (
              <>
                <Text style={s.small}>{browserEnvCount} 个浏览器环境</Text>
                <Chip
                  label={browser.connected ? '已连接' : '未连接'}
                  tone={browser.connected ? 'success' : 'neutral'}
                />
              </>
            )
          }
          actions={
            <>
              <Btn small label="添加浏览器环境" onPress={() => onOpenDrawer('add-browser')} />
              <Btn small label="编辑" onPress={() => onOpenDrawer('browser')} />
            </>
          }
        />

        <FeatureCard
          title="云端会话"
          description="把 claude.ai 网页中运行的云端 Claude Code 会话接入 Paseo。"
          kv={
            cloudSessionError && !resolvedCloud ? (
              <>
                <Chip label="读取失败" tone="danger" />
                <Text style={s.small}>读取失败：{cloudSessionError}</Text>
              </>
            ) : !resolvedCloud ? (
              <Text style={s.small}>正在读取…</Text>
            ) : (
              <>
                <Chip
                  label={`${resolvedCloud.onlineSessions} 个在线`}
                  tone={resolvedCloud.onlineSessions > 0 ? 'success' : 'neutral'}
                />
                {resolvedCloud.unackedMessages > 0 ? (
                  <Chip label={`${resolvedCloud.unackedMessages} 条未确认`} tone="warning" />
                ) : null}
              </>
            )
          }
          actions={<Btn small label="编辑" onPress={() => onOpenDrawer('cloud')} />}
        />

      </View>
    </View>
  );
}

function AnswerPage({ onOpenDrawer }: { onOpenDrawer(id: DrawerId): void }) {
  const { s, control, theme } = useUi();
  const {
    presence,
    presenceError,
    escalation,
    escalationStatus,
    escalationError,
    quiet,
    quietStatus,
    quietError,
    machineSettings,
    moduleReloading,
    modules,
  } = useControlState();
  const [actionError, setActionError] = useState<string | null>(null);

  const presenceModOff = isModuleOff('answer.presence', machineSettings, modules);
  const escModOff = isModuleOff('answer.escalation', machineSettings, modules) || escalationStatus === 'disabled';
  const quietModOff = isModuleOff('answer.quietChildren', machineSettings, modules) || quietStatus === 'disabled';

  const settings = presence?.settings ?? null;
  const observedMode = presence?.observation.mode ?? 'unknown';
  const effectiveOnline = settings
    ? settings.mode === 'online' || (settings.mode === 'auto' && observedMode !== 'offline')
    : false;
  const localHostId = presence?.hosts[0]?.id ?? null;
  const lastPlayedSpeech = presence?.speech
    ? [...presence.speech]
        .reverse()
        .find(item => item.played && item.engine && (item.hostId === null || (localHostId !== null && item.hostId === localHostId)))
    : undefined;

  const escState = escalation?.blockedReason
    ? { label: '旧插件仍启用', tone: 'danger' as const }
    : !escalation?.enabled || escalation.status === 'stopped'
    ? { label: '未运行', tone: 'neutral' as const }
    : escalation.status === 'error'
      ? { label: '异常', tone: 'danger' as const }
      : { label: '运行中', tone: 'success' as const };

  return (
    <View style={{ gap: 14 }}>
      <View style={{ gap: 4 }}>
        <Text style={s.h1}>问题答复</Text>
        <Text style={s.muted}>
          插件不代答。问答模式控制是否播报语音提醒，升级通知按时段规则把未答提问发给总控（Grok），由总控按你的选择画像决定。
        </Text>
      </View>

      {actionError ? (
        <Notice tone="danger">
          <Text style={s.text}>{actionError}</Text>
        </Notice>
      ) : null}

      {!escModOff && (escalationError || escalation?.error) ? (
        <Notice tone="danger">
          <View style={[s.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}>
            <Text style={s.text}>升级通知异常：{escalationError ?? escalation?.error}</Text>
            <Btn small label="查看" onPress={() => onOpenDrawer('escalation')} />
          </View>
        </Notice>
      ) : null}

      <View style={[s.wrap, { alignItems: 'stretch', gap: 10 }]}>
        <ModuleFeatureCard
          title="问答模式"
          moduleId="answer.presence"
          label="启用问答模式、蓝牙和语音提醒"
          belowTitle={
            presenceModOff ? null : settings ? (
              <Segmented
                options={[
                  { value: 'online', label: '在线' },
                  { value: 'offline', label: '离线' },
                  { value: 'auto', label: '自动' },
                ]}
                value={settings.mode}
                onChange={mode => {
                  setActionError(null);
                  void control.configurePresence({ ...settings, mode }).catch(e => setActionError(errorMessage(e)));
                }}
              />
            ) : (
              <Chip label={presenceError ? '读取失败' : '正在读取'} tone={presenceError ? 'danger' : 'neutral'} />
            )
          }
          description="会话向你提问时，插件不代答；在线时语音提醒，离线时不播语音并通知总控。开关同时控制问答模式、蓝牙在场判定和语音提醒。"
          kv={
            presenceModOff ? (
              <ModuleOffHint />
            ) : presenceError ? (
              <Text style={s.small}>读取失败：{presenceError}</Text>
            ) : !presence || !settings ? (
              <Text style={s.small}>正在读取…</Text>
            ) : (
              <>
                <Chip
                  label={effectiveOnline ? '判定在线' : '判定离线'}
                  tone={effectiveOnline ? 'success' : 'warning'}
                />
                <Text style={s.small}>
                  {settings.mode === 'auto'
                    ? `自动：${presence.observation.reason || '判定未知'}`
                    : settings.mode === 'online'
                      ? '手动在线'
                      : '手动离线'}
                </Text>
              </>
            )
          }
          actions={<Btn small label="编辑" onPress={() => onOpenDrawer('qa-mode')} />}
        />

        <FeatureCard
          title="蓝牙在场判定"
          trailing={
            presenceModOff ? (
              <Chip label="未启用" tone="neutral" />
            ) : presenceError ? (
              <Chip label="读取失败" tone="danger" />
            ) : !presence ? (
              <Chip label="正在读取" tone="neutral" />
            ) : (
              <Chip
                label={observedMode === 'offline' ? '离开' : observedMode === 'online' ? '在线' : '未知'}
                tone={observedMode === 'offline' ? 'warning' : observedMode === 'online' ? 'success' : 'neutral'}
              />
            )
          }
          description="按随身蓝牙设备是否在场，自动切换在线或离线。"
          kv={
            presenceModOff ? (
              <ModuleOffHint />
            ) : presenceError ? (
              <Text style={s.small}>读取失败：{presenceError}</Text>
            ) : !presence || !settings ? (
              <Text style={s.small}>正在读取…</Text>
            ) : (
              <>
                <Text style={s.small}>{presence.observation.reason || '未配置蓝牙设备'}</Text>
                <Text style={s.small}>
                  {settings.mode === 'auto' ? '问答模式正在跟随蓝牙' : '问答模式当前为手动'}
                </Text>
              </>
            )
          }
          actions={<Btn small label="编辑" onPress={() => onOpenDrawer('bluetooth')} />}
        />

        <ModuleFeatureCard
          title="升级通知"
          moduleId="answer.escalation"
          label="升级通知"
          featureEnabled={escalation?.enabled}
          description="主会话有提问未回答时，按时段规则通知 Grok（不代答，代答由总控决定）。"
          kv={
            escModOff ? (
              <ModuleOffHint />
            ) : escalationStatus === 'error' || escalationError ? (
              <>
                <Chip label="读取失败" tone="danger" />
                <Text style={s.small}>读取失败：{escalationError ?? '无法读取升级通知'}</Text>
              </>
            ) : !escalation ? (
              <Text style={s.small}>正在读取…</Text>
            ) : (
              <>
                <Chip label={escState.label} tone={escState.tone} />
                {escalation.blockedReason ? <Text style={s.small}>先停用旧插件“会话事件通知”，再重载本插件</Text> : null}
              </>
            )
          }
          actions={<Btn small label="编辑" onPress={() => onOpenDrawer('escalation')} />}
        />

        <ModuleFeatureCard
          title="子会话免提醒"
          moduleId="answer.quietChildren"
          label="子会话免提醒"
          featureEnabled={quiet?.enabled}
          description="子会话和未置顶工作区的会话不直接提醒你，异常归并到主会话。"
          kv={
            quietModOff ? (
              <ModuleOffHint />
            ) : quietStatus === 'error' || quietError ? (
              <>
                <Chip label="读取失败" tone="danger" />
                <Text style={s.small}>读取失败：{quietError ?? '无法读取免提醒设置'}</Text>
              </>
            ) : !quiet ? (
              <Text style={s.small}>正在读取…</Text>
            ) : (
              <Text style={s.small}>主会话：{quiet.pinnedWorkspaceCount} 个置顶工作区</Text>
            )
          }
          actions={<Btn small label="编辑" onPress={() => onOpenDrawer('quiet-children')} />}
        />

        <FeatureCard
          title="语音提醒"
          trailing={
            <Switch
              accessibilityLabel="语音提醒"
              disabled={moduleReloading || !presence || presenceModOff}
              value={!presenceModOff && Boolean(presence?.localSpeechEnabled)}
              onValueChange={enabled => {
                if (!presence || presenceModOff) return;
                void control
                  .configureLocalSpeech(enabled)
                  .catch(e => setActionError(errorMessage(e)));
              }}
              trackColor={{ true: theme.colors.accent, false: theme.colors.border }}
              thumbColor={theme.colors.accentForeground}
            />
          }
          description={`判定在线时，这台电脑（${presence?.hostName || '本机'}）播报所有电脑上会话的新提问。`}
          kv={
            presenceModOff ? (
              <ModuleOffHint />
            ) : presenceError ? (
              <Text style={s.small}>读取失败：{presenceError}</Text>
            ) : !presence ? (
              <Text style={s.small}>正在读取…</Text>
            ) : (
              <>
                <Chip
                  label={presence.localSpeechEnabled ? '本机播放开启' : '本机不播放'}
                  tone={presence.localSpeechEnabled ? 'success' : 'neutral'}
                />
                {presence.hasSpeechTarget === false ? (
                  <Chip label="当前没有主机会播放" tone="warning" />
                ) : null}
                {lastPlayedSpeech ? (
                  <Chip
                    label={lastPlayedSpeech.engine === 'neural' ? '最近：神经语音' : '最近：系统语音'}
                    tone={lastPlayedSpeech.engine === 'neural' ? 'neutral' : 'warning'}
                  />
                ) : (
                  <Chip label="尚未播放" tone="neutral" />
                )}
                <Text style={s.small}>{presence.hostName || '本机'}</Text>
                {lastPlayedSpeech?.engine === 'system' && lastPlayedSpeech.detail ? (
                  <Text style={[s.small, { color: theme.colors.statusWarning }]}>
                    {`回退原因：${lastPlayedSpeech.detail}`}
                  </Text>
                ) : null}
              </>
            )
          }
          actions={<Btn small label="编辑" onPress={() => onOpenDrawer('speech')} />}
        />
      </View>
    </View>
  );
}

function GithubPage({ onOpenDrawer }: { onOpenDrawer(id: DrawerId): void }) {
  const { s, store, theme } = useUi();
  const { snapshot, error } = useStoreState();
  const { machineSettings, modules, moduleReloading } = useControlState();
  const [actionError, setActionError] = useState<string | null>(null);

  const githubModOff = isModuleOff('github', machineSettings, modules);
  const prefs = snapshot?.preferences ?? null;
  const repoCount = snapshot?.repositories.length ?? 0;

  return (
    <View style={{ gap: 14 }}>
      <Text style={s.h1}>GitHub 订阅</Text>

      {actionError ? (
        <Notice tone="danger">
          <Text style={s.text}>{actionError}</Text>
        </Notice>
      ) : null}

      {!githubModOff && snapshot && !snapshot.token.configured ? (
        <Notice tone="warning">
          <View style={[s.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}>
            <Text style={s.text}>未保存 GitHub 令牌，无法轮询事件。</Text>
            <Btn small label="去编辑面板填写" onPress={() => onOpenDrawer('github-config')} />
          </View>
        </Notice>
      ) : null}

      {!githubModOff && (error || snapshot?.error) ? (
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
              disabled={moduleReloading || !prefs || githubModOff}
              value={!githubModOff && (prefs?.enabled ?? false)}
              onValueChange={enabled => {
                if (!prefs) return;
                void store
                  .savePreferences({ ...prefs, enabled })
                  .catch(e => setActionError(errorMessage(e)));
              }}
              trackColor={{ true: theme.colors.accent, false: theme.colors.border }}
              thumbColor={theme.colors.accentForeground}
            />
          }
          description="轮询已订阅的仓库与 PR，把新事件直接发到对应会话。"
          kv={
            githubModOff ? (
              <ModuleOffHint />
            ) : error ? (
              <>
                <Chip label="读取失败" tone="danger" />
                <Text style={s.small}>读取失败：{error}</Text>
              </>
            ) : !prefs ? (
              <Text style={s.small}>正在读取…</Text>
            ) : (
              <>
                <Chip
                  label={prefs.shadow ? '影子' : '实际发送'}
                  tone={prefs.shadow ? 'warning' : 'success'}
                />
                <Text style={s.small}>
                  {prefs.organization || '未设置组织'} · {repoCount} 个仓库
                </Text>
              </>
            )
          }
          actions={<Btn small label="编辑" onPress={() => onOpenDrawer('github-config')} />}
        />
      </View>

      <GitHubSubscriptionsViews onEditConfig={() => onOpenDrawer('github-config')} />
    </View>
  );
}

export function TodoItemCard({ item }: { item: TodoItem }) {
  const { s, control, navigation, theme } = useUi();
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<QuestionDraftState>({ answers: {}, otherAnswers: {} });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prompts = item.question?.prompts ?? [];
  const selected = draft.answers;
  const otherText = draft.otherAnswers;
  const canSubmit =
    prompts.length > 0 &&
    prompts.every(p => isPromptComplete(p, selected[p.question] ?? [], otherText[p.question]));

  const openItemAgent = (agentId: string) => {
    navigation?.openAgent({
      agentId,
      ...(item.hostId && item.hostId !== 'local' ? { serverId: item.hostId } : {}),
    });
  };

  const toggleChoice = (prompt: QuestionPrompt, label: string) => {
    setDraft(prev => {
      const current = prev.answers[prompt.question] ?? [];
      const nextPicked = prompt.multiSelect
        ? current.includes(label)
          ? current.filter(x => x !== label)
          : [...current, label]
        : [label];
      return pickPromptOption(prompt, prev, nextPicked);
    });
  };

  const submitAnswer = async () => {
    if (!item.question || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const answers: Record<string, string[]> = {};
      const otherAnswers: Record<string, string> = {};
      for (const p of prompts) {
        const picks = [...(selected[p.question] ?? [])];
        const custom = (otherText[p.question] ?? '').trim();
        if (custom) otherAnswers[p.question] = custom;
        answers[p.question] = picks;
      }
      const res = await control.actTodo({
        hostId: item.hostId,
        action: {
          type: 'answer',
          questionId: item.question.questionId,
          answers,
          ...(Object.keys(otherAnswers).length > 0 ? { otherAnswers } : {}),
        },
      });
      if (!res.ok) {
        setError(res.message || '提交回答未成功');
        return;
      }
      setExpanded(false);
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
      const res = await control.actTodo({
        hostId: item.hostId,
        action: {
          type: 'ack-escalation',
          escalationId: item.escalationId,
          agentId: item.agentId,
        },
      });
      if (!res.ok) setError(res.message || '标记已处理未成功');
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const badgeTone =
    item.type === 'ask' || item.type === 'native' || item.type === 'esc'
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
                  onPress={() => openItemAgent(item.agentId!)}
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
          ) : item.type === 'stall' || item.type === 'native' ? (
            <Btn
              small
              primary
              label="打开会话"
              onPress={() => {
                if (item.agentId) openItemAgent(item.agentId);
              }}
            />
          ) : null}
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
                        onPress={() => toggleChoice(p, opt.label)}
                      />
                    );
                  })}
                </View>
                {p.allowOther ? (
                  <TextInput
                    accessibilityLabel={`其他回答 ${p.question}`}
                    style={s.input}
                    value={otherText[p.question] ?? ''}
                    onChangeText={val => setDraft(prev => changePromptOther(p, prev, val))}
                    placeholder="其他回答（可选）"
                    placeholderTextColor={theme.colors.foregroundMuted}
                  />
                ) : null}
              </View>
            );
          })}
          <View style={s.row}>
            <Btn
              primary
              label="提交回答"
              disabled={!canSubmit || busy}
              busy={busy}
              onPress={() => void submitAnswer()}
            />
          </View>
        </View>
      ) : null}

      {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}
    </View>
  );
}

function TodoPage() {
  const { s, now, theme } = useUi();
  const { todo, todoError, stalled } = useControlState();
  const [subtab, setSubtab] = useState<'list' | 'log'>('list');
  const [filter, setFilter] = useState<'all' | TodoType>('all');

  const items = todo?.items ?? [];
  const logs = todo?.logs ?? [];
  const countByType = (t: TodoType) => items.filter(i => i.type === t).length;
  const stalledScanning = stalled !== null && stalled.scannedAt === null;

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
                ['native', `会话提问 ${countByType('native')}`],
                ['web', `网页等待 ${countByType('web')}`],
                ['stall', `停滞会话 ${stalledScanning && countByType('stall') === 0 ? '扫描中' : countByType('stall')}`],
                ['esc', `升级事件 ${countByType('esc')}`],
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
                <Text style={s.muted}>
                  {stalledScanning && (filter === 'all' || filter === 'stall')
                    ? '停滞会话扫描中…'
                    : '当前没有需要处理的插件待办项。'}
                </Text>
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
  const { s, theme, compact } = useUi();
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

  const openDrawer = (id: DrawerId) => {
    setDrawer(id);
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
              启停 Provider、模型、额度在 Paseo 设置和额度面板。令牌、API key 与 Webhook 凭据在对应卡片的编辑面板配置。
            </Text>
          </View>
        ) : null}
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={[s.pageContent, { maxWidth: 980 }]}>
        {controlState.machineSettingsError || controlState.machineSettings?.errors.length ? (
          <Notice tone="danger">
            <Text style={s.text}>读取本机设置失败：{[controlState.machineSettingsError, ...(controlState.machineSettings?.errors ?? [])].filter(Boolean).join('；')}</Text>
          </Notice>
        ) : null}
        {page === 'providers' ? <ProvidersPage onOpenDrawer={openDrawer} /> : null}
        {page === 'answer' ? <AnswerPage onOpenDrawer={openDrawer} /> : null}
        {page === 'github' ? <GithubPage onOpenDrawer={openDrawer} /> : null}
        {page === 'todo' ? <TodoPage /> : null}
      </ScrollView>

      <DrawerOverlay
        drawerId={drawer}
        onClose={() => {
          setDrawer(null);
        }}
        onOpenDrawer={openDrawer}
      />
    </View>
  );
}
