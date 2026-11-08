import type { AgentPermissionResponse } from '@getpaseo/protocol/agent-types';
import { QuestionPromptSchema, type QuestionPrompt } from '../../shared/presence.ts';
import type { WebRequestContext } from '../../shared/web-request.ts';
import { validateAnswers } from '../questions.ts';

export type NormalizedWebAnswer =
  | { ok: true; answers: Record<string, string[]>; otherAnswers?: Record<string, string> }
  | { ok: false; status: 'unknown'; detail: 'dismissed' | 'invalid_answer' };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function parseExpectedPrompts(expected: WebRequestContext['expected']): QuestionPrompt[] | null {
  if (expected.toolName !== 'AskUserQuestion' || !isPlainObject(expected.input)) return null;
  const questions = expected.input.questions;
  if (!Array.isArray(questions) || !questions.length || questions.length > 10) return null;
  if (questions.some(prompt => !isPlainObject(prompt) || !Array.isArray(prompt.options) || !prompt.options.length || prompt.options.some(option => !isPlainObject(option)))) return null;
  const parsed = QuestionPromptSchema.array().safeParse(questions.map(prompt => ({
    question: prompt.question,
    ...(typeof prompt.header === 'string' ? { header: prompt.header } : {}),
    multiSelect: prompt.multiSelect === true,
    allowOther: prompt.allowOther !== false,
    options: (prompt.options as Record<string, unknown>[]).map(option => ({
      label: option.label,
      description: option.description ?? '',
      recommended: option.recommended === true || (typeof option.label === 'string' && /(?:\(recommended\)|（推荐）|\(推荐\)|\[recommended\])\s*$/i.test(option.label)),
    })),
  })));
  if (!parsed.success) return null;
  if (new Set(parsed.data.map(prompt => prompt.question)).size !== parsed.data.length) return null;
  if (parsed.data.some(prompt => new Set(prompt.options.map(option => option.label)).size !== prompt.options.length)) return null;
  return parsed.data;
}

function parseMultiSelectString(raw: string, optionLabels: string[]): { labels: string[]; other?: string } | null {
  if (!raw.trim()) return null;
  const states = new Map<number, { count: number; sample: string[] }>();
  for (const label of optionLabels) {
    if (raw.startsWith(label, 0)) {
      const end = label.length;
      const existing = states.get(end);
      if (!existing) states.set(end, { count: 1, sample: [label] });
      else existing.count = Math.min(2, existing.count + 1);
    }
  }
  for (let pos = 1; pos <= raw.length; pos++) {
    const current = states.get(pos);
    if (!current || !raw.startsWith(', ', pos)) continue;
    const nextStart = pos + 2;
    for (const label of optionLabels) {
      if (raw.startsWith(label, nextStart)) {
        const end = nextStart + label.length;
        const existing = states.get(end);
        if (!existing) states.set(end, { count: current.count, sample: [...current.sample, label] });
        else existing.count = Math.min(2, existing.count + current.count);
      }
    }
  }
  const validPositions = [...states.keys()].filter(pos => pos === raw.length || raw.startsWith(', ', pos));
  if (!validPositions.length) return { labels: [], other: raw };
  const maxPos = Math.max(...validPositions);
  const best = states.get(maxPos)!;
  if (best.count > 1) return null;
  if (maxPos === raw.length) return { labels: best.sample };
  const rest = raw.slice(maxPos + 2).trim();
  if (!rest) return null;
  return { labels: best.sample, other: rest };
}

export function toWebAnswer(expected: WebRequestContext['expected'], response: AgentPermissionResponse): NormalizedWebAnswer {
  if (response.behavior === 'deny') return { ok: false, status: 'unknown', detail: 'dismissed' };
  if (response.behavior !== 'allow' || !isPlainObject(response.updatedInput)) return { ok: false, status: 'unknown', detail: 'invalid_answer' };
  const prompts = parseExpectedPrompts(expected);
  if (!prompts) return { ok: false, status: 'unknown', detail: 'invalid_answer' };

  const rawAnswers = response.updatedInput.answers;
  const rawOtherAnswers = response.updatedInput.otherAnswers;
  if (!isPlainObject(rawAnswers)) return { ok: false, status: 'unknown', detail: 'invalid_answer' };
  if (rawOtherAnswers !== undefined && !isPlainObject(rawOtherAnswers)) return { ok: false, status: 'unknown', detail: 'invalid_answer' };

  const byQuestion = new Map<string, QuestionPrompt>();
  const headerCounts = new Map<string, number>();
  for (const prompt of prompts) {
    byQuestion.set(prompt.question, prompt);
    if (prompt.header) headerCounts.set(prompt.header, (headerCounts.get(prompt.header) ?? 0) + 1);
  }
  const byUniqueHeader = new Map<string, QuestionPrompt>();
  for (const prompt of prompts) {
    if (prompt.header && headerCounts.get(prompt.header) === 1 && !byQuestion.has(prompt.header)) {
      byUniqueHeader.set(prompt.header, prompt);
    }
  }
  const resolvePrompt = (key: string): QuestionPrompt | null => byQuestion.get(key) ?? byUniqueHeader.get(key) ?? null;

  const answerByQuestion = new Map<string, unknown>();
  for (const [key, value] of Object.entries(rawAnswers)) {
    const prompt = resolvePrompt(key);
    if (!prompt || answerByQuestion.has(prompt.question)) return { ok: false, status: 'unknown', detail: 'invalid_answer' };
    answerByQuestion.set(prompt.question, value);
  }

  const otherByQuestion = new Map<string, string>();
  if (rawOtherAnswers) {
    for (const [key, value] of Object.entries(rawOtherAnswers)) {
      const prompt = resolvePrompt(key);
      if (!prompt || otherByQuestion.has(prompt.question) || typeof value !== 'string') return { ok: false, status: 'unknown', detail: 'invalid_answer' };
      const trimmed = value.trim();
      if (!trimmed || trimmed.length > 2000) return { ok: false, status: 'unknown', detail: 'invalid_answer' };
      otherByQuestion.set(prompt.question, trimmed);
    }
  }

  const answers: Record<string, string[]> = {};
  const otherAnswers: Record<string, string> = {};

  for (const prompt of prompts) {
    const hasAnswer = answerByQuestion.has(prompt.question);
    const explicitOther = otherByQuestion.get(prompt.question);
    if (!hasAnswer && explicitOther === undefined) return { ok: false, status: 'unknown', detail: 'invalid_answer' };
    const raw = answerByQuestion.get(prompt.question);
    const optionLabels = prompt.options.map(option => option.label);

    if (Array.isArray(raw) || raw === undefined) {
      if (Array.isArray(raw) && raw.some(item => typeof item !== 'string')) return { ok: false, status: 'unknown', detail: 'invalid_answer' };
      answers[prompt.question] = raw ? (raw as string[]) : [];
      if (explicitOther !== undefined) otherAnswers[prompt.question] = explicitOther;
    } else if (typeof raw === 'string') {
      if (!prompt.multiSelect) {
        if (optionLabels.includes(raw)) {
          answers[prompt.question] = [raw];
          if (explicitOther !== undefined) otherAnswers[prompt.question] = explicitOther;
        } else {
          if (explicitOther !== undefined) return { ok: false, status: 'unknown', detail: 'invalid_answer' };
          const trimmed = raw.trim();
          if (!trimmed || trimmed.length > 2000) return { ok: false, status: 'unknown', detail: 'invalid_answer' };
          answers[prompt.question] = [];
          otherAnswers[prompt.question] = trimmed;
        }
      } else {
        const parsed = parseMultiSelectString(raw, optionLabels);
        if (!parsed) return { ok: false, status: 'unknown', detail: 'invalid_answer' };
        if (parsed.other !== undefined && explicitOther !== undefined) return { ok: false, status: 'unknown', detail: 'invalid_answer' };
        const other = parsed.other ?? explicitOther;
        answers[prompt.question] = parsed.labels;
        if (other !== undefined) {
          const trimmed = other.trim();
          if (!trimmed || trimmed.length > 2000) return { ok: false, status: 'unknown', detail: 'invalid_answer' };
          otherAnswers[prompt.question] = trimmed;
        }
      }
    } else {
      return { ok: false, status: 'unknown', detail: 'invalid_answer' };
    }
  }

  try {
    validateAnswers(prompts, answers, Object.keys(otherAnswers).length ? otherAnswers : undefined);
  } catch {
    return { ok: false, status: 'unknown', detail: 'invalid_answer' };
  }

  return {
    ok: true,
    answers,
    ...(Object.keys(otherAnswers).length ? { otherAnswers } : {}),
  };
}
