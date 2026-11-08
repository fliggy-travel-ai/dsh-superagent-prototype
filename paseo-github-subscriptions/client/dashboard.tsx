import type { PluginScreenProps, PluginSurfaceProps } from '@getpaseo/plugin/client';
import { useEffect, useRef, useState } from 'react';
import { Linking, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import type { AutomationSnapshot } from '../shared/automation.ts';
import type { BrowserPairing, BrowserSnapshot } from '../shared/browser.ts';
import type { BrowserUsageSettings } from '../shared/browser-usage.ts';
import { errorMessage } from './store.ts';
import { GitHubPanel } from './screen/index.tsx';
import { PresencePanel, QuestionList, todoQuestions, presenceLabel } from './presence-panel.tsx';
import { isUnreadAutomaticAnswer } from '../shared/presence.ts';
import { Btn, Card, Chip, Notice, useControlState, useStoreState, useUi } from './ui.tsx';

type Section = 'overview' | 'sessions' | 'browser' | 'usage' | 'github' | 'todos' | 'activity';
type Run = (operation: () => Promise<unknown>) => Promise<void>;
type Session = AutomationSnapshot['sessions'][number];
const sections: Array<{ id: Section; title: string }> = [
  { id: 'overview', title: '概览' }, { id: 'sessions', title: '问答模式' },
  { id: 'browser', title: '浏览器分组' }, { id: 'usage', title: '额度设置' },
  { id: 'github', title: 'GitHub 订阅' },
  { id: 'todos', title: '人工待办' }, { id: 'activity', title: '最近动作' },
];
const toolNames: Record<string, string> = { Read: '读取文件', Glob: '查找文件', Grep: '搜索内容', Edit: '编辑文件', Write: '写入文件', MultiEdit: '多处编辑', NotebookEdit: '编辑笔记本' };

export function AdsPowerKeyCard() {
  const { s, control, theme } = useUi();
  const [settings, setSettings] = useState<BrowserUsageSettings | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    control.usageSettings()
      .then(res => { if (active) setSettings(res); })
      .catch(() => { if (active) setSettings({ adspowerApiKeyConfigured: false, adspowerApiKeySource: 'none' }); });
    return () => { active = false; };
  }, [control]);

  const save = async () => {
    const candidate = value.trim();
    if (!candidate || busy) return;
    setBusy('save');
    setError(null);
    try {
      const res = await control.saveAdsPowerApiKey(candidate);
      setValue('');
      setSettings(res);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy('remove');
    setError(null);
    try {
      const res = await control.removeAdsPowerApiKey();
      setValue('');
      setSettings(res);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  };

  const isConfigured = Boolean(settings?.adspowerApiKeyConfigured);
  const isFromEnv = settings?.adspowerApiKeySource === 'env';
  const canClear = isConfigured && !isFromEnv;
  const statusLabel = settings === null
    ? '读取中'
    : isFromEnv
      ? '已配置（来自环境变量）'
      : isConfigured
        ? '已配置'
        : '未配置';

  return <Card
    title="额度设置（AdsPower API key）"
    trailing={<Chip label={statusLabel} tone={isConfigured ? 'success' : 'neutral'} />}
  >
    <Text style={s.text}>当前状态：{settings === null ? '正在读取…' : statusLabel}</Text>
    <Text style={s.muted}>用于通过本机 AdsPower 本地 API（默认 http://127.0.0.1:50325）查询浏览器环境的名称。API key 只保存在本机插件状态里（文件权限 0600），不写日志，不返回给前端；保留环境变量 PASEO_ADSPOWER_API_KEY / ADSPOWER_API_KEY 作为后备来源。</Text>
    <Text style={s.muted}>要准确显示浏览器环境名称，请在浏览器扩展选项页填写一次环境序号；单环境自动识别只在单个活跃环境且单个扩展上报时生效。</Text>
    <TextInput
      accessibilityLabel="AdsPower API key"
      style={s.input}
      value={value}
      onChangeText={setValue}
      placeholder={isConfigured ? '重新填写 AdsPower API key 以更换' : '填写 AdsPower API key'}
      placeholderTextColor={theme.colors.foregroundMuted}
      secureTextEntry
      autoCapitalize="none"
      autoCorrect={false}
      autoComplete="off"
      spellCheck={false}
      contextMenuHidden
    />
    {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{error}</Text> : null}
    <View style={s.wrap}>
      <Btn
        primary
        label={isConfigured ? '重新填写并保存' : '保存 API key'}
        disabled={!value.trim() || busy !== null}
        busy={busy === 'save'}
        onPress={() => void save()}
      />
      {canClear ? <Btn
        danger
        label="清除 API key"
        disabled={busy !== null}
        busy={busy === 'remove'}
        onPress={() => void remove()}
      /> : null}
    </View>
  </Card>;
}

export function UsageSettingsScreen(_props: PluginSurfaceProps) {
  const { s } = useUi();
  return <ScrollView style={s.page} contentContainerStyle={s.pageContent}>
    <Text style={s.h1}>额度设置</Text>
    <AdsPowerKeyCard />
  </ScrollView>;
}

function Browsers({ snapshot, native, busy, run }: { snapshot: BrowserSnapshot; native: AutomationSnapshot | null; busy: boolean; run: Run }) {
  const { s, control } = useUi();
  const [port, setPort] = useState(String(snapshot.settings.port));
  const [pairing, setPairing] = useState<BrowserPairing | null>(null);
  const [binding, setBinding] = useState<BrowserSnapshot['sessions'][number] | null>(null);
  const [target, setTarget] = useState<Session | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [filter, setFilter] = useState('');
  return <View style={{ gap: 12 }}>
    <Card title="Paseo 名称同步（可选）" trailing={<Chip label={snapshot.connected ? '扩展已连接' : snapshot.settings.enabled ? '等待扩展连接' : '未启用名称同步'} tone={snapshot.connected ? 'success' : 'neutral'} />}>
      <Text style={s.text}>浏览器扩展安装后即自动点同意，并按网页会话名称分组。无需配对或设置本页。</Text>
      <Text style={s.muted}>只有需要使用 Paseo 会话名称时，才启用下方名称同步。自动点击开关在浏览器扩展选项中。</Text>
      <View style={s.wrap}><Text style={s.text}>本机桥接端口</Text>
        <TextInput accessibilityLabel="浏览器桥接端口" value={port} onChangeText={setPort} keyboardType="number-pad" style={[s.input, { width: 100 }]} />
        <Btn label={snapshot.settings.enabled ? '保存端口' : '启用名称同步'} busy={busy} onPress={() => void run(async () => {
          await control.configureBrowser({ enabled: true, port: Number(port) }); setPairing(null);
        })} />
        {snapshot.settings.enabled ? <Btn label="暂停名称同步" disabled={busy} onPress={() => void run(async () => { await control.configureBrowser({ ...snapshot.settings, enabled: false }); setPairing(null); })} /> : null}
        <Btn label={pairing ? '隐藏配对信息' : '查看扩展配对信息'} disabled={!snapshot.settings.enabled || busy} onPress={() => void run(async () => setPairing(pairing ? null : await control.pairing()))} />
      </View>
      {pairing && snapshot.settings.enabled ? <View style={{ gap: 6 }}>
        <Text style={s.text}>在浏览器扩展管理页加载本插件中的 browser-extension 目录，再打开扩展选项页，填写环境名称和以下信息。</Text>
        <Text style={s.muted}>配对信息仅供本机扩展使用。</Text>
        <TextInput accessibilityLabel="配对地址" value={pairing.url} editable={false} style={s.input} />
        <TextInput accessibilityLabel="配对令牌" value={pairing.token} editable={false} selectTextOnFocus style={s.input} />
      </View> : null}
    </Card>
    <AdsPowerKeyCard />
    {binding ? <Card title={`为「${binding.title}」选择 Paseo 名称`}>
      <Text style={s.text}>浏览器环境：{binding.instanceName}。绑定后分组使用所选 Paseo 会话名称。</Text>
      <TextInput accessibilityLabel="搜索绑定目标" placeholder="搜索 Paseo 会话名称" value={filter} onChangeText={setFilter} style={s.input} />
      <View style={s.wrap}>{native?.sessions.filter(session => session.title.toLowerCase().includes(filter.toLowerCase())).slice(0, 30).map(session =>
        <Btn key={session.id} label={`${session.title}（${session.workspacePath?.split('/').filter(Boolean).at(-1) || session.provider} · ${session.id.slice(-6)}）`} primary={target?.id === session.id}
          onPress={() => { setTarget(session); setConfirmed(false); }} />)}</View>
      {target ? <Text style={s.muted}>{target.workspacePath || target.title}</Text> : null}
      <View style={s.row}><Switch accessibilityLabel="确认浏览器会话对应关系" value={confirmed} onValueChange={setConfirmed} /><Text style={[s.text, { flex: 1 }]}>我确认所选 Paseo 会话与当前网页对应。</Text></View>
      <View style={s.wrap}><Btn label="保存名称绑定" primary disabled={!confirmed || !target || busy} onPress={() => void run(async () => {
        await control.bind({ instanceId: binding.instanceId, sessionId: binding.sessionId, agentId: target!.id }); setBinding(null);
      })} /><Btn label="取消绑定" disabled={busy} onPress={() => setBinding(null)} /></View>
    </Card> : null}
    {!snapshot.sessions.length ? <Text style={s.muted}>等待已配对扩展同步 Claude 网页标签。扩展断开时保留已有分组。</Text> : null}
    {snapshot.sessions.map(session => <Card key={`${session.instanceId}:${session.sessionId}`} title={session.title} trailing={<Chip label="Claude 网页" tone="accent" />}>
      <Text style={s.text}>环境：{session.instanceName} · {session.tabCount} 个标签 · 分组：{session.groupTitle}</Text>
      <Text style={s.muted}>{session.agentId ? '已绑定 Paseo 名称' : '使用网页自身标题'} · 最近同步 {new Date(session.lastSeenAt).toLocaleTimeString()}</Text>
      <View style={s.wrap}>
        <Btn label="绑定 Paseo 名称" disabled={busy || !native} onPress={() => { setBinding(session); setTarget(null); setConfirmed(false); }} />
        {session.agentId ? <Btn label="解除名称绑定" disabled={busy} onPress={() => void run(() => control.bind({ instanceId: session.instanceId, sessionId: session.sessionId, agentId: null }))} /> : null}
      </View>
    </Card>)}
  </View>;
}

export function MainScreen({ params }: PluginScreenProps) {
  const { s, compact, control, store, navigation } = useUi();
  const { automation, browser, presence, stalled, stalledError, automationError, browserError, presenceError } = useControlState();
  const { snapshot: github, error: githubError } = useStoreState();
  const initial = sections.find(item => item.id === params.section)?.id ?? (params.tab ? 'github' : 'overview');
  const [section, setSection] = useState<Section>(initial);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const restoring = useRef<{ nativePaused: boolean; presencePaused: boolean; browserEnabled: boolean; githubEnabled: boolean } | null>(null);
  const working = useRef(false);
  const run: Run = async operation => {
    if (working.current) return;
    working.current = true; setBusy(true); setProblem(null);
    try { await operation(); } catch (error) { setProblem(errorMessage(error)); }
    finally { working.current = false; setBusy(false); }
  };
  const pending = automation?.sessions.flatMap(session => session.pending.filter(request => request.state === 'manual' && request.kind !== 'question').map(request => ({ session, request }))) ?? [];
  const asked = todoQuestions(presence);
  const unreadAnswers = asked.filter(isUnreadAutomaticAnswer).length;
  const stalledCount = stalled?.sessions.length ?? 0;
  const waitingPages = (browser?.sessions ?? []).filter(session => ['waiting', 'limited'].includes(session.activity?.state ?? '') && Date.now() - Date.parse(session.lastSeenAt) < 90_000 && !asked.some(question => question.sessionId === session.sessionId));
  const todoCount = pending.length + asked.length + stalledCount + waitingPages.length;
  const toggleAll = (restoreRequested = false) => run(async () => {
    const restore = restoreRequested ? restoring.current : null;
    restoring.current ??= { nativePaused: automation?.paused ?? true, presencePaused: presence?.settings.paused ?? false, browserEnabled: browser?.settings.enabled ?? false, githubEnabled: github?.preferences.enabled ?? false };
    const results = await Promise.allSettled([
      control.pause(restore?.nativePaused ?? true),
      presence ? control.configurePresence({ ...presence.settings, paused: restore?.presencePaused ?? true }) : Promise.reject(new Error('问答模块状态不可用')),
      browser ? control.configureBrowser({ ...browser.settings, enabled: restore?.browserEnabled ?? false }) : Promise.reject(new Error('浏览器模块状态不可用')),
      github ? store.savePreferences({ ...github.preferences, enabled: restore?.githubEnabled ?? false }) : Promise.reject(new Error('GitHub 模块状态不可用')),
    ]);
    if (results.some(result => result.status === 'rejected')) throw new Error('部分模块未能更新，请查看模块状态，再重试对应操作。');
    if (restore) restoring.current = null;
  });
  return <ScrollView style={s.page} contentContainerStyle={s.pageContent}>
    <View style={[s.wrap, { justifyContent: 'space-between' }]}>
      <View style={{ gap: 4, maxWidth: '100%', flexShrink: 1 }}><Text style={s.h1}>开发自动化</Text><Text style={s.muted}>当前主机：{automation?.hostName || presence?.hostName || '正在连接'} · 问答模式、浏览器分组与 GitHub 订阅</Text></View>
      <View style={s.wrap}>
        <Btn label="暂停 Paseo 模块" busy={busy} onPress={() => void toggleAll()} />
        {restoring.current ? <Btn label="恢复本页暂停前状态" disabled={busy || !automation || !browser || !github} onPress={() => void toggleAll(true)} /> : null}
      </View>
    </View>
    <View style={s.wrap}>{sections.map(item => <Btn key={item.id} label={item.id === 'todos' ? `${item.title}（${todoCount}）` : item.title}
      primary={section === item.id} onPress={() => setSection(item.id)} />)}</View>
    {problem ? <Notice tone="danger"><Text style={s.text}>{problem}</Text></Notice> : null}
    {[automationError || automation?.error, presenceError && `问答模式：${presenceError}`, browserError || browser?.error, githubError].filter(Boolean).map((error, index) =>
      <Notice key={index} tone="warning"><Text style={s.text}>{error}</Text></Notice>)}
    {automation?.truncated ? <Notice tone="warning"><Text style={s.text}>会话列表超过显示上限。未显示的会话不作不存在处理。</Text></Notice> : null}
    {section === 'overview' ? <View style={{ gap: 14 }}>
      <View style={{ flexDirection: compact ? 'column' : 'row', gap: 12 }}>
        {[
          { title: '问答模式', value: presence ? presenceLabel(presence).label : '正在连接', detail: presence ? `${asked.length - unreadAnswers} 个提问待处理 · ${unreadAnswers} 个代答未读` : '正在读取问答状态', target: 'sessions' as Section },
          { title: 'Paseo 名称同步', value: browser ? browser.settings.enabled ? '已启用' : '未启用' : '正在连接', detail: `${browser?.sessions.length ?? 0} 个已同步网页会话；扩展可独立使用`, target: 'browser' as Section },
          { title: 'GitHub 订阅', value: github ? github.preferences.enabled ? '已启用' : '已暂停' : '正在连接', detail: `${github?.subscriptions.length ?? 0} 条订阅`, target: 'github' as Section },
        ].map(item => <View key={item.title} style={{ flex: 1 }}><Card title={item.title}><Text style={s.h1}>{item.value}</Text><Text style={s.muted}>{item.detail}</Text><Btn label={`查看${item.title}`} onPress={() => setSection(item.target)} /></Card></View>)}
      </View>
      <Card title="需要你处理">
        <Text style={s.text}>{todoCount ? `${asked.length - unreadAnswers} 个会话提问待处理，${unreadAnswers} 个代答未读；${pending.length} 个其他原生请求，${stalledCount} 个停滞主会话。` : '当前没有已确认的待办。'}</Text>
        {stalledError || stalled?.error ? <Text style={s.muted}>停滞状态未完全确认，请到人工待办查看原因。</Text> : null}
        <Text style={s.muted}>原生会话和 Claude 网页的提问都可以在人工待办中直接选择并提交。</Text>
        <Btn label="查看人工待办" onPress={() => setSection('todos')} />
      </Card>
    </View> : null}
    {section === 'sessions' ? presence ? <PresencePanel snapshot={presence} busy={busy} run={run} /> : <Text style={s.muted}>{presenceError ? '问答模式暂不可用，原因见页面顶部。其他模块不受影响。' : '正在读取问答模式状态…'}</Text> : null}
    {section === 'browser' && browser ? <Browsers snapshot={browser} native={automation} busy={busy} run={run} /> : null}
    {section === 'browser' && !browser ? <Text style={s.muted}>正在读取模块状态；连接错误会显示在页面顶部。</Text> : null}
    {section === 'usage' ? <View style={{ gap: 12 }}><AdsPowerKeyCard /></View> : null}
    {section === 'github' ? <GitHubPanel params={params} /> : null}
    {section === 'todos' ? <View style={{ gap: 12 }}>
      <Text style={s.strong}>会话提问</Text>
      <Text style={s.muted}>未回答问题和未读代答保留在此。人工回答完成后自动移出；代答确认完成后可点击“已读”。</Text>
      {presence ? <QuestionList snapshot={presence} busy={busy} run={run} /> : <Text style={s.muted}>{presenceError ? '会话提问暂不可用，原因见页面顶部。' : '正在读取会话提问…'}</Text>}
      <Text style={s.strong}>停滞主会话</Text>
      <Text style={s.muted}>主会话没有工作、没有有效监听，原生子代理和跨主机子会话也没有工作时显示。恢复活动后自动移出。</Text>
      {stalledError || stalled?.error ? <Notice tone="warning"><Text style={s.text}>{stalledError || stalled?.error}</Text></Notice> : null}
      {!stalled && !stalledError ? <Text style={s.muted}>正在核对主机、监听和子会话状态…</Text> : null}
      {stalled && !stalled.error && !stalled.sessions.length ? <Text style={s.muted}>暂无停滞主会话。</Text> : null}
      {stalled?.sessions.map(session => <Card key={session.agentId} title={session.title} trailing={<Chip label="停滞" tone="warning" />}>
        <Text style={s.muted}>最后活动：{new Date(session.since).toLocaleString()}</Text>
        <Text selectable style={s.text}>{session.lastMessage || session.messageError || '最近的时间线中没有助手消息，请打开会话查看。'}</Text>
        {navigation ? <Btn label="打开 Paseo 会话" onPress={() => navigation.openAgent({ agentId: session.agentId })} /> : null}
      </Card>)}
      <Text style={s.strong}>网页等待处理</Text>
      <Text style={s.muted}>显示网页的等待输入和用量限制提示。网页后台任务及监听状态需打开原会话核对；此处不会自动发送继续指令或切换账号。</Text>
      {!waitingPages.length ? <Text style={s.muted}>暂无网页等待提示。</Text> : null}
      {waitingPages.map(session => <Card key={`${session.instanceId}:${session.sessionId}`} title={`${session.instanceName} · ${session.groupTitle}`} trailing={<Chip label={session.activity?.state === 'limited' ? '达到用量限制' : '等待输入'} tone="warning" />}>
        <Text style={s.muted}>{session.activity?.reason}</Text>
        <Text selectable style={s.text}>{session.activity?.lastMessage || '页面没有可读取的最后消息。'}</Text>
        <Btn label="打开原网页处理" onPress={() => { void Linking.openURL(session.url); }} />
      </Card>)}
      <Text style={s.strong}>其他原生请求</Text>
      <Text style={s.muted}>工具审批等请求到原会话查看完整内容并作出决定。</Text>
      {!pending.length ? <Text style={s.text}>暂无其他待处理请求。</Text> : null}
      {pending.map(({ session, request }) => <Card key={`${session.id}:${request.id}`} title={session.title}>
        <Text style={s.strong}>{request.title}</Text><Text style={s.text}>{request.reason}</Text><Text style={s.muted}>{session.workspacePath}</Text>
        {navigation ? <Btn label="打开 Paseo 会话处理" onPress={() => navigation.openAgent({ agentId: session.id })} /> : null}
      </Card>)}
    </View> : null}
    {section === 'activity' ? <View style={{ gap: 12 }}>
      <Text style={s.strong}>网页权限动作</Text>
      <Text style={s.muted}>窗口消失只表示权限窗口已关闭，不代表命令执行成功。仍显示的请求请回网页处理。</Text>
      {!(browser?.approvals ?? []).length ? <Text style={s.text}>尚无网页权限动作记录。</Text> : null}
      {(browser?.approvals ?? []).slice(-30).reverse().map(entry => <Card key={`${entry.instanceId}:${entry.reservationId}`} title={entry.instanceName} trailing={<Chip label={{ reserved: '等待回执', dismissed: '窗口已消失', 'still-visible': '窗口仍显示', skipped: '已跳过' }[entry.status]} tone={entry.status === 'dismissed' ? 'success' : 'warning'} />}>
        <Text style={s.text}>{entry.button} · {new Date(entry.at).toLocaleString()}</Text>
        <Btn label="打开原网页" onPress={() => void Linking.openURL(`https://claude.ai/code/session_${entry.sessionId}`)} />
      </Card>)}
      <Text style={s.muted}>原生权限响应记录。发送响应不代表命令执行成功；结果未知时不会再次响应。</Text>
      {!automation?.audit.length ? <Text style={s.text}>尚无原生权限响应记录。</Text> : null}
      {automation?.audit.slice(0, 100).map(entry => <Card key={entry.id} title={entry.title} trailing={<Chip label={entry.status === 'resolved' ? '宿主已处理' : entry.status === 'unknown' ? '结果未知' : '等待确认'} tone={entry.status === 'resolved' ? 'success' : 'warning'} />}>
        <Text style={s.text}>{toolNames[entry.tool] || entry.tool} · {new Date(entry.at).toLocaleString()}</Text>
        {entry.resolution ? <Text style={s.muted}>{entry.resolution === 'allow' ? '宿主确认已批准' : entry.resolution === 'deny' ? '宿主确认已拒绝' : '请求已消失，未确认最终决定'}</Text> : null}
        {navigation ? <Btn label="打开 Paseo 会话" onPress={() => navigation.openAgent({ agentId: entry.agentId })} /> : null}
      </Card>)}
      <Btn label="查看 GitHub 事件记录" onPress={() => setSection('github')} />
    </View> : null}
  </ScrollView>;
}
