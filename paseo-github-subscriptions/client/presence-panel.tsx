import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { isQuestionTodo, isUnreadAutomaticAnswer, type PresenceSnapshot, type Question, type QuestionAnswer, type QuestionPrompt } from '../shared/presence.ts';
import { Btn, Card, Chip, useUi, type Tone } from './ui.tsx';

type Run = (operation: () => Promise<unknown>) => Promise<void>;

const observed = { online: '在线', offline: '离线', unknown: '未知' } as const;
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

function PromptBlock({ prompt, picked, other, open, disabled, pick, changeOther }: { prompt: QuestionPrompt; picked: string[]; other: string; open: boolean; disabled: boolean; pick(next: string[]): void; changeOther(value: string): void }) {
  const { s, theme } = useUi();
  return <View style={{ gap: 6 }}>
    {prompt.header ? <Text style={s.small}>{prompt.header}{prompt.multiSelect ? ' · 可多选' : ''}</Text> : prompt.multiSelect ? <Text style={s.small}>可多选</Text> : null}
    <Text style={s.text}>{prompt.question}</Text>
    {!prompt.options.length && !prompt.allowOther ? <Text style={s.muted}>这个问题没有选项，请到原会话回答。</Text> : null}
    {prompt.options.map(option => {
      const selected = picked.includes(option.label);
      return <Option key={option.label} label={option.label} detail={option.description} recommended={option.recommended} selected={selected} multi={prompt.multiSelect} disabled={disabled}
        onPress={() => pick(prompt.multiSelect ? selected ? picked.filter(item => item !== option.label) : [...picked, option.label] : [option.label])} />;
    })}
    {prompt.allowOther && open ? <TextInput accessibilityLabel={`${prompt.question} 其他`} placeholder="其他（自由输入）" placeholderTextColor={theme.colors.foregroundMuted}
      value={other} editable={!disabled} maxLength={2000} onChangeText={changeOther} style={s.input} /> : null}
    {!open && other ? <Text style={s.text}>其他：{other}</Text> : null}
  </View>;
}

export function QuestionCard({ question, busy, run }: { question: Question; busy: boolean; run: Run }) {
  const { s, control, navigation } = useUi();
  const [draft, setDraft] = useState<QuestionDraftState>({ answers: {}, otherAnswers: {} });
  const open = question.state === 'pending';
  const answerable = isQuestionAnswerable(question);
  const complete = isQuestionComplete(question, draft.answers, draft.otherAnswers);
  const lacksRecommendation = question.prompts.some(prompt => !prompt.options.some(option => option.recommended));
  const unread = isUnreadAutomaticAnswer(question);
  const state = unread ? { label: '已代答 · 未读', tone: 'accent' as const } : states[question.state];
  return <Card title={question.title || '会话提问'} trailing={<View style={s.row}>
    <Chip label={question.source === 'native' ? '原生会话' : 'Claude 网页'} tone="accent" /><Chip label={state.label} tone={state.tone} />
  </View>}>
    <Text style={s.muted}>{new Date(question.at).toLocaleString()}{question.source === 'browser' && question.url ? ` · ${question.url}` : ''}</Text>
    {question.reason ? <Text style={s.muted}>{question.reason}</Text> : null}
    {question.answer ? <Text style={s.strong}>{question.answer.source === 'automatic' ? '自动代答选择' : '你提交的回答'}</Text> : null}
    {question.prompts.map(prompt => <PromptBlock key={prompt.question} prompt={prompt}
      picked={(open ? draft.answers : question.answer?.answers)?.[prompt.question] ?? []}
      other={(open ? draft.otherAnswers : question.answer?.otherAnswers)?.[prompt.question] ?? ''}
      open={open} disabled={!open || busy}
      pick={next => setDraft(current => pickPromptOption(prompt, current, next))}
      changeOther={value => setDraft(current => changePromptOther(prompt, current, value))} />)}
    {open ? <Text style={s.small}>{lacksRecommendation ? '有问题没有推荐项，离线模式也等待你回答。' : '离线模式会选择标为推荐的选项。'}</Text> : null}
    <View style={s.wrap}>
      {unread ? <Btn label="已读" primary disabled={busy} onPress={() => void run(() => control.markQuestionRead({ id: question.id, fingerprint: question.fingerprint }))} /> : null}
      {open && answerable ? <Btn label="提交回答" primary disabled={!complete || busy} onPress={() => void run(() => control.answerQuestion(buildQuestionSubmission(question, draft.answers, draft.otherAnswers)))} /> : null}
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
