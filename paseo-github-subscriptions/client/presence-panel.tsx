import { useState } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';
import { isQuestionTodo, isUnreadAutomaticAnswer, type PresenceSettings, type PresenceSnapshot, type Question, type QuestionPrompt } from '../shared/presence.ts';
import { Btn, Card, Chip, Notice, useUi, type Tone } from './ui.tsx';
import { BluetoothPanel } from './bluetooth-panel.tsx';

type Run = (operation: () => Promise<unknown>) => Promise<void>;

const modes: Array<{ id: PresenceSettings['mode']; title: string; detail: string }> = [
  { id: 'auto', title: '自动', detail: '按手机蓝牙判断在线或离线' },
  { id: 'online', title: '在线', detail: '语音提醒，等待你回答' },
  { id: 'offline', title: '离线', detail: '只选明确推荐项；没有推荐项仍等待你' },
];
const observed = { online: '在线', offline: '离线', unknown: '未知' } as const;
const sourceName = { bluetooth: '手机蓝牙', manual: '手动选择', unavailable: '来源不可用' } as const;
const states: Record<Question['state'], { label: string; tone: Tone }> = {
  pending: { label: '等待回答', tone: 'warning' }, submitted: { label: '已提交，等待确认', tone: 'accent' },
  resolved: { label: '已处理', tone: 'success' }, unknown: { label: '结果未知', tone: 'danger' },
};

export function presenceLabel(snapshot: PresenceSnapshot): { label: string; tone: Tone } {
  const { settings, observation } = snapshot;
  if (settings.paused) return { label: '已暂停', tone: 'neutral' };
  if (settings.mode === 'online') return { label: '在线', tone: 'success' };
  if (settings.mode === 'offline') return { label: '离线', tone: 'accent' };
  if (observation.mode === 'unknown') return { label: '自动 · 判定未知', tone: 'warning' };
  return { label: `自动 · ${observed[observation.mode]}`, tone: observation.mode === 'online' ? 'success' : 'accent' };
}

export const todoQuestions = (snapshot: PresenceSnapshot | null) => snapshot?.questions.filter(isQuestionTodo) ?? [];

export function PresencePanel({ snapshot, busy, run }: { snapshot: PresenceSnapshot; busy: boolean; run: Run }) {
  const { s, theme, compact, control } = useUi();
  const { settings, observation } = snapshot;
  const state = presenceLabel(snapshot);
  const save = (patch: Partial<PresenceSettings>) => void run(() => control.configurePresence({ ...settings, ...patch }));
  const hosts = snapshot.hosts.length ? snapshot.hosts.map((host, index) => ({ ...host, id: index === 0 ? null : host.id })) : [{ id: null, name: `本机（${snapshot.hostName || '当前主机'}）`, online: true }];
  const missing = settings.sourceHostId !== null && !snapshot.hosts.some(host => host.id === settings.sourceHostId);
  return <View style={{ gap: 12 }}>
    <Card title="问答模式" trailing={<Chip label={state.label} tone={state.tone} />}>
      <Text style={s.text}>会话提问时，按所选模式处理。Paseo 原生会话和 Claude 网页的提问都适用。</Text>
      <View style={{ flexDirection: compact ? 'column' : 'row', gap: 8 }}>{modes.map(mode => {
        const active = settings.mode === mode.id;
        return <Pressable key={mode.id} accessibilityRole="radio" accessibilityLabel={`${mode.title}：${mode.detail}`} accessibilityState={{ checked: active, disabled: busy }}
          disabled={busy} onPress={() => { if (!active) save({ mode: mode.id }); }}
          style={[s.button, { flex: compact ? undefined : 1, alignItems: 'flex-start', paddingVertical: 10, gap: 2 }, active ? s.buttonPrimary : null, busy ? { opacity: 0.6 } : null]}>
          <Text style={active ? s.buttonPrimaryText : s.strong}>{mode.title}</Text>
          <Text style={[s.small, active ? { color: theme.colors.accentForeground } : null]}>{mode.detail}</Text>
        </Pressable>;
      })}</View>
      {settings.mode === 'auto'
        ? <Text style={s.muted}>蓝牙判定：{observed[observation.mode]} · {sourceName[observation.source]}{observation.reason ? ` · ${observation.reason}` : ''} · {observation.observedAt ? `更新于 ${new Date(observation.observedAt).toLocaleTimeString()}` : '尚未取得判定'}</Text>
        : <Text style={s.muted}>已手动选择{settings.mode === 'online' ? '在线' : '离线'}，不按蓝牙切换。</Text>}
      {settings.mode === 'auto' && observation.mode === 'unknown' && !settings.paused ? <Notice tone="warning">
        <Text style={s.strong}>无法判定在线或离线</Text>
        <Text style={s.text}>{observation.reason || '来源主机未提供原因。'}</Text>
        <Text style={s.muted}>判定未知时不自动选择，等待你回答。也可以手动选择在线或离线。</Text>
      </Notice> : null}
      {snapshot.error ? <Notice tone="warning"><Text style={s.text}>{snapshot.error}</Text></Notice> : null}
      <View style={s.wrap}>
        <View style={s.row}><Switch accessibilityLabel="暂停问答处理" value={settings.paused} disabled={busy} onValueChange={paused => save({ paused })} /><Text style={s.text}>暂停问答处理</Text></View>
        <View style={s.row}><Switch accessibilityLabel="语音提醒" value={settings.speechEnabled} disabled={busy} onValueChange={speechEnabled => save({ speechEnabled })} /><Text style={s.text}>语音提醒</Text></View>
      </View>
      {settings.paused ? <Text style={s.muted}>已暂停：不自动选择，也不发语音提醒。提问仍显示在人工待办。</Text> : null}
      <Text style={s.strong}>蓝牙与声音来源主机</Text>
      <View style={s.wrap}>{hosts.map(host => <Btn key={host.id ?? 'local'} label={`${host.name}${host.online ? '' : '（离线）'}`}
        primary={settings.sourceHostId === host.id || (host.id === null && settings.sourceHostId === snapshot.hosts[0]?.id)} disabled={busy} onPress={() => { if (settings.sourceHostId !== host.id) save({ sourceHostId: host.id }); }} />)}</View>
      <Text style={s.muted}>在所选主机上检测蓝牙设备并播放语音提醒。{missing ? `已选主机（${settings.sourceHostId}）当前不在主机列表中。` : ''}</Text>
    </Card>
    <BluetoothPanel key={settings.sourceHostId || 'local'} hostId={settings.sourceHostId} busy={busy} />
  </View>;
}

function Option({ label, detail, recommended, selected, multi, disabled, onPress }: { label: string; detail: string; recommended: boolean; selected: boolean; multi: boolean; disabled: boolean; onPress(): void }) {
  const { s, theme } = useUi();
  return <Pressable accessibilityRole={multi ? 'checkbox' : 'radio'} accessibilityLabel={`${label}${recommended ? '（推荐）' : ''}`} accessibilityState={{ checked: selected, disabled }}
    disabled={disabled} onPress={onPress}
    style={[s.button, { alignItems: 'flex-start', gap: 2 }, selected ? { borderColor: theme.colors.accent, backgroundColor: theme.colors.surface0 } : null, disabled && !selected ? { opacity: 0.6 } : null]}>
    <View style={s.row}>
      <Text style={{ color: selected ? theme.colors.accent : theme.colors.foregroundMuted, fontSize: 14 }}>{multi ? selected ? '☑' : '☐' : selected ? '◉' : '○'}</Text>
      <Text style={s.strong}>{label}</Text>
      {recommended ? <Chip label="推荐" tone="success" /> : null}
    </View>
    {detail ? <Text style={s.muted}>{detail}</Text> : null}
  </Pressable>;
}

function PromptBlock({ prompt, picked, disabled, pick }: { prompt: QuestionPrompt; picked: string[]; disabled: boolean; pick(next: string[]): void }) {
  const { s } = useUi();
  return <View style={{ gap: 6 }}>
    {prompt.header ? <Text style={s.small}>{prompt.header}{prompt.multiSelect ? ' · 可多选' : ''}</Text> : prompt.multiSelect ? <Text style={s.small}>可多选</Text> : null}
    <Text style={s.text}>{prompt.question}</Text>
    {!prompt.options.length ? <Text style={s.muted}>这个问题没有选项，请到原会话回答。</Text> : null}
    {prompt.options.map(option => {
      const selected = picked.includes(option.label);
      return <Option key={option.label} label={option.label} detail={option.description} recommended={option.recommended} selected={selected} multi={prompt.multiSelect} disabled={disabled}
        onPress={() => pick(prompt.multiSelect ? selected ? picked.filter(item => item !== option.label) : [...picked, option.label] : [option.label])} />;
    })}
  </View>;
}

export function QuestionCard({ question, busy, run }: { question: Question; busy: boolean; run: Run }) {
  const { s, control, navigation } = useUi();
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const open = question.state === 'pending';
  const answerable = question.prompts.every(prompt => prompt.options.length > 0);
  const complete = answerable && question.prompts.every(prompt => (answers[prompt.question]?.length ?? 0) > 0);
  const lacksRecommendation = question.prompts.some(prompt => !prompt.options.some(option => option.recommended));
  const unread = isUnreadAutomaticAnswer(question);
  const state = unread ? { label: '已代答 · 未读', tone: 'accent' as const } : states[question.state];
  return <Card title={question.title || '会话提问'} trailing={<View style={s.row}>
    <Chip label={question.source === 'native' ? '原生会话' : 'Claude 网页'} tone="accent" /><Chip label={state.label} tone={state.tone} />
  </View>}>
    <Text style={s.muted}>{new Date(question.at).toLocaleString()}{question.source === 'browser' && question.url ? ` · ${question.url}` : ''}</Text>
    {question.reason ? <Text style={s.muted}>{question.reason}</Text> : null}
    {question.answer ? <Text style={s.strong}>{question.answer.source === 'automatic' ? '自动代答选择' : '你提交的回答'}</Text> : null}
    {question.prompts.map(prompt => <PromptBlock key={prompt.question} prompt={prompt} picked={(open ? answers : question.answer?.answers)?.[prompt.question] ?? []} disabled={!open || busy}
      pick={next => setAnswers(current => ({ ...current, [prompt.question]: next }))} />)}
    {open ? <Text style={s.small}>{lacksRecommendation ? '有问题没有推荐项，离线模式也等待你回答。' : '离线模式会选择标为推荐的选项。'}</Text> : null}
    <View style={s.wrap}>
      {unread ? <Btn label="已读" primary disabled={busy} onPress={() => void run(() => control.markQuestionRead({ id: question.id, fingerprint: question.fingerprint }))} /> : null}
      {open && answerable ? <Btn label="提交回答" primary disabled={!complete || busy} onPress={() => void run(() => control.answerQuestion({ id: question.id, answers }))} /> : null}
      {question.source === 'native' && navigation ? <Btn label="打开 Paseo 会话" onPress={() => navigation.openAgent({ agentId: question.sessionId })} /> : null}
    </View>
    {unread ? <Text style={s.small}>点击“已读”表示你已知悉代答结果，此问题将移出人工待办。</Text> : null}
  </Card>;
}

export function QuestionList({ snapshot, busy, run }: { snapshot: PresenceSnapshot; busy: boolean; run: Run }) {
  const { s } = useUi();
  const order = { pending: 0, unknown: 1, submitted: 2, resolved: 3 } as const;
  const questions = todoQuestions(snapshot).sort((left, right) => order[left.state] - order[right.state] || Date.parse(right.at) - Date.parse(left.at));
  if (!questions.length) return <Text style={s.text}>暂无会话提问。</Text>;
  return <View style={{ gap: 12 }}>{questions.map(question => <QuestionCard key={`${question.id}:${question.fingerprint}`} question={question} busy={busy} run={run} />)}</View>;
}
