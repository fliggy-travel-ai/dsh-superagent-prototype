import { createHash } from 'node:crypto';
import type { AgentPermissionRequest, AgentPermissionResponse } from '@getpaseo/protocol/agent-types';
import { z } from 'zod';
import { CLOUD_SESSION_PROVIDER_ID } from '../shared/cloud-session.ts';
import { QuestionPromptSchema, type BrowserQuestion, type QuestionPrompt, type QuestionAnswer } from '../shared/presence.ts';

export type OwnerOnlyCategory =
  | 'daily_task'
  | 'retro_review'
  | 'local_confirm'
  | 'final_acceptance'
  | 'login_verification'
  | 'payment'
  | 'destructive_cleanup';

export type QuestionAudience = {
  ownerOnly: boolean;
  category: OwnerOnlyCategory | null;
  reason: string | null;
};

export type OwnerOnlyOptions = {
  workspaceTitle?: string | null;
  agentLabels?: Record<string, string> | null;
  parentLabels?: Record<string, string> | null;
  localKeywords?: readonly string[] | null;
};

export type AnswerVia = 'paseo-permission' | 'cloud-session' | 'browser-only';

export type EscalationPrompt = {
  question: string;
  header: string | null;
  answerKey: string;
  multiSelect: boolean;
  allowOther: boolean;
  options: Array<{
    label: string;
    description: string;
    recommended: boolean;
  }>;
};

export const DEFAULT_LOCAL_CONFIRM_KEYWORDS = [
  '仍要运行',
  'Open Anyway',
  '软件阻断提醒',
  '隐私与安全性',
  'Touch ID',
  '认证窗口',
  '在 MacBook 前',
  '在 Mac Mini 前',
  '本人完成',
] as const;

export const OwnerOnlyConfigSchema = z.object({
  localKeywords: z.array(z.string().min(1)).default([...DEFAULT_LOCAL_CONFIRM_KEYWORDS]),
});
export type OwnerOnlyConfig = z.infer<typeof OwnerOnlyConfigSchema>;
export const OWNER_ONLY_FALLBACK: OwnerOnlyConfig = {
  localKeywords: [...DEFAULT_LOCAL_CONFIRM_KEYWORDS],
};

export const questionFingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const cleanText = (value: string) => value.replace(/\s+/g, ' ').trim();

function singlePromptMatches(expected: QuestionPrompt, actual: QuestionPrompt): boolean {
  if (cleanText(expected.question) !== cleanText(actual.question)) return false;
  if (Boolean(expected.multiSelect) !== Boolean(actual.multiSelect)) return false;
  const expectedLabels = expected.options.map(option => cleanText(option.label));
  const actualLabels = actual.options.map(option => cleanText(option.label));
  if (expectedLabels.length !== actualLabels.length) return false;
  const actualSet = new Set(actualLabels);
  return actualSet.size === expectedLabels.length && expectedLabels.every(label => actualSet.has(label));
}

export function browserQuestionMatchesPrompts(
  expectedPrompts: QuestionPrompt[],
  browser: Pick<BrowserQuestion, 'prompts' | 'pages' | 'toolUseId'>,
  expectedToolUseId?: string,
): boolean {
  if (browser.toolUseId && expectedToolUseId && browser.toolUseId !== expectedToolUseId) return false;
  if (browser.pages && browser.pages > 1) {
    if (expectedPrompts.length !== browser.pages || !browser.prompts.length) return false;
    return singlePromptMatches(expectedPrompts[0]!, browser.prompts[0]!);
  }
  if (expectedPrompts.length !== browser.prompts.length) return false;
  return expectedPrompts.every((prompt, index) => singlePromptMatches(prompt, browser.prompts[index]!));
}

export function nativePrompts(request: AgentPermissionRequest): QuestionPrompt[] | null {
  if (request.kind !== 'question' || !['AskUserQuestion', 'request_user_input', 'request_user_input_async'].includes(request.name)) return null;
  const input = request.input as { questions?: unknown } | undefined;
  if (!Array.isArray(input?.questions) || !input.questions.length || input.questions.length > 10) return null;
  if (input.questions.some(prompt => !prompt || typeof prompt !== 'object' || Array.isArray(prompt) ||
    Array.isArray(prompt.options) && prompt.options.some((option: unknown) => !option || typeof option !== 'object' || Array.isArray(option)))) return null;
  const parsed = QuestionPromptSchema.array().safeParse(input.questions.map(prompt => ({
    question: prompt.question, ...(typeof prompt.header === 'string' ? { header: prompt.header } : {}),
    multiSelect: prompt.multiSelect === true,
    ...(request.name === 'AskUserQuestion' ? { allowOther: true } : {}),
    options: Array.isArray(prompt.options) ? prompt.options.map((option: Record<string, unknown>) => ({
      label: option.label, description: option.description ?? '',
      recommended: option.recommended === true || typeof option.label === 'string' && /[（(\[]\s*(?:recommended|推荐)\s*[）)\]]\s*$/i.test(option.label),
    })) : [],
  })));
  return parsed.success && new Set(parsed.data.map(prompt => prompt.question)).size === parsed.data.length ? parsed.data : null;
}

export function validateAnswers(prompts: QuestionPrompt[], answers: Record<string, string[]>, otherAnswers?: Record<string, string>) {
  if (Object.keys(answers).length !== prompts.length) throw new Error('请回答每一个问题');
  if (otherAnswers && Object.keys(otherAnswers).some(key => !prompts.some(prompt => prompt.question === key))) throw new Error('选项已变化，请重新读取问题');
  for (const prompt of prompts) {
    const selected = answers[prompt.question];
    const hasOtherKey = Boolean(otherAnswers && Object.hasOwn(otherAnswers, prompt.question) && otherAnswers[prompt.question] !== undefined);
    const other = hasOtherKey ? otherAnswers![prompt.question]!.trim() : '';
    if (hasOtherKey && (!prompt.allowOther || !other || other.length > 2000)) throw new Error('选项已变化，请重新读取问题');
    const count = (selected?.length ?? 0) + (hasOtherKey ? 1 : 0);
    if (!Array.isArray(selected) || (!prompt.multiSelect ? count !== 1 : count < 1) || new Set(selected).size !== selected.length ||
      selected.some(label => prompt.options.filter(option => option.label === label).length !== 1)) throw new Error('选项已变化，请重新读取问题');
  }
}

export function extractQuestionPrompts(data: unknown): QuestionPrompt[] {
  if (!data || typeof data !== 'object') return [];
  const strict = nativePrompts(data as AgentPermissionRequest);
  if (strict) return strict;
  const d = data as Record<string, unknown>;
  const name = typeof d.name === 'string' ? d.name : '';
  const input = d.input as { questions?: unknown } | undefined;
  const rawQuestions = Array.isArray(input?.questions)
    ? input.questions
    : Array.isArray((d as { prompts?: unknown }).prompts)
      ? (d as { prompts: unknown[] }).prompts
      : [];
  const fallback: QuestionPrompt[] = [];
  for (const item of rawQuestions) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const q = item as Record<string, unknown>;
    const question = typeof q.question === 'string' ? q.question : '';
    if (!question) continue;
    const header = typeof q.header === 'string' ? q.header : undefined;
    const multiSelect = q.multiSelect === true;
    const allowOther = typeof q.allowOther === 'boolean' ? q.allowOther : name.includes('AskUserQuestion') || q.isOther === true;
    const rawOptions = Array.isArray(q.options) ? q.options : [];
    const options = rawOptions
      .map((opt): QuestionPrompt['options'][number] | null => {
        if (typeof opt === 'string') {
          return {
            label: opt,
            description: '',
            recommended: /[（(\[]\s*(?:recommended|推荐)\s*[）)\]]\s*$/i.test(opt),
          };
        }
        if (opt && typeof opt === 'object' && !Array.isArray(opt)) {
          const o = opt as Record<string, unknown>;
          const label = typeof o.label === 'string' ? o.label : '';
          if (!label) return null;
          return {
            label,
            description: typeof o.description === 'string' ? o.description : '',
            recommended:
              o.recommended === true ||
              o.isRecommended === true ||
              /[（(\[]\s*(?:recommended|推荐)\s*[）)\]]\s*$/i.test(label),
          };
        }
        return null;
      })
      .filter((opt): opt is QuestionPrompt['options'][number] => opt !== null);
    fallback.push({
      question,
      ...(header !== undefined ? { header } : {}),
      multiSelect,
      ...(allowOther ? { allowOther: true } : {}),
      options,
    });
  }
  return fallback;
}

export function toEscalationPrompts(
  prompts: QuestionPrompt[],
  options?: { requestName?: string | null; answerVia?: AnswerVia },
): EscalationPrompt[] {
  const useHeaderKey = options?.answerVia === 'paseo-permission' &&
    Boolean(options?.requestName && !options.requestName.includes('AskUserQuestion'));
  return prompts.map(prompt => ({
    question: prompt.question,
    header: prompt.header ?? null,
    answerKey: useHeaderKey ? (prompt.header || prompt.question) : prompt.question,
    multiSelect: Boolean(prompt.multiSelect),
    allowOther: Boolean(prompt.allowOther),
    options: prompt.options.map(option => ({
      label: option.label,
      description: option.description ?? '',
      recommended: Boolean(option.recommended),
    })),
  }));
}

export function classifyAudience(prompts: QuestionPrompt[], options?: OwnerOnlyOptions): QuestionAudience {
  const workspaceTitle = options?.workspaceTitle?.trim() ?? '';
  if (
    options?.agentLabels?.['paseo.schedule-id'] ||
    options?.parentLabels?.['paseo.schedule-id'] ||
    workspaceTitle.startsWith('【每日')
  ) {
    return { ownerOnly: true, category: 'daily_task', reason: '每日任务弹窗须 Yang 本人查看' };
  }

  const texts = prompts.map(prompt =>
    [prompt.question, prompt.header ?? '', ...prompt.options.flatMap(option => [option.label, option.description])].join('\n'),
  );

  if (
    workspaceTitle.includes('【复盘待审】') ||
    texts.some(text => text.includes('复盘') && /(?:审阅|审核|通过|意见|去留)/.test(text))
  ) {
    return { ownerOnly: true, category: 'retro_review', reason: '问题涉及复盘审阅，请用户本人确认' };
  }

  const keywords = (options?.localKeywords ?? DEFAULT_LOCAL_CONFIRM_KEYWORDS).map(k => k.trim()).filter(Boolean);
  if (
    keywords.length &&
    texts.some(text => {
      const lower = text.toLowerCase();
      return keywords.some(kw => lower.includes(kw.toLowerCase()));
    })
  ) {
    return { ownerOnly: true, category: 'local_confirm', reason: '问题涉及本机确认或本人现场操作，请用户本人确认' };
  }

  if (
    texts.some(text =>
      /(?:最终验收|验收(?:方式|结论|通过)|按[^\n]{0,60}证据验收|确认[^\n]{0,30}验收|\bacceptance\s+(?:sign.?off|approval)\b)/i.test(text),
    )
  ) {
    return { ownerOnly: true, category: 'final_acceptance', reason: '问题涉及最终验收结论，请用户本人确认' };
  }

  if (
    texts.some(text =>
      /(?:验证码|两步验证|双重验证|安全验证|登录|登陆|扩大权限|提升权限|授予.*权限|绕过.*审批|关闭.*安全|one.time.password|\b(?:MFA|2FA|OTP|login|log\s*in|sign\s*in)\b|bypass.*permission|disable.*safeguard|(?:grant|expand|elevate).*\b(?:access|permission|privilege))/i.test(text),
    )
  ) {
    return { ownerOnly: true, category: 'login_verification', reason: '问题涉及登录、验证或访问权限，请人工确认' };
  }

  if (
    texts.some(text =>
      /(?:转账|付款|支付|扣款|退款|充值|购买|订阅付费|\b(?:payment|purchase|refund|transfer\s+(?:money|funds)|charge\s+(?:card|account))\b)/i.test(text),
    )
  ) {
    return { ownerOnly: true, category: 'payment', reason: '问题涉及资金操作，请人工确认' };
  }

  for (const text of texts) {
    const cleanup = /(?:删除|清理|清空|释放|销毁|移除|丢弃|归档|\b(?:delet\w*|clean\w*|purge|releas\w*|destroy\w*|remov\w*|discard\w*|archiv\w*|decommission\w*)\b)/i.test(text);
    const resource = /(?:沙箱|工作树|分支|未提交|未推送|改动|数据|目录|文件|日志|证据|备份|账号|账户|云资源|环境|数据库|\b(?:sandbox\w*|worktree\w*|branch\w*|uncommitted|unpushed|changes|data|director\w*|files?|logs?|evidence|backups?|accounts?|environment\w*|database\w*|cloud\s+resources?)\b)/i.test(text);
    if (cleanup && resource || /(?:\brm\s+-[a-z]*r|\bgit\s+(?:clean|reset\s+--hard|worktree\s+remove)|永久删除|全部丢弃)/i.test(text)) {
      return { ownerOnly: true, category: 'destructive_cleanup', reason: '问题涉及资源清理、释放或改动丢弃，请人工确认' };
    }
  }

  return { ownerOnly: false, category: null, reason: null };
}

export function ownerOnlyReason(prompts: QuestionPrompt[], options?: OwnerOnlyOptions): string | null {
  return classifyAudience(prompts, options).reason;
}

export function nativeResponse(
  request: AgentPermissionRequest,
  answers: QuestionAnswer['answers'],
  otherAnswers?: QuestionAnswer['otherAnswers'],
): AgentPermissionResponse {
  const prompts = nativePrompts(request);
  if (!prompts) throw new Error('此请求不是受支持的问答');
  validateAnswers(prompts, answers, otherAnswers);
  if (request.provider === CLOUD_SESSION_PROVIDER_ID) {
    const mappedAnswers: Record<string, string[]> = {};
    const mappedOther: Record<string, string> = {};
    for (const prompt of prompts) {
      mappedAnswers[prompt.question] = [...(answers[prompt.question] ?? [])];
      const other = otherAnswers?.[prompt.question]?.trim();
      if (other) mappedOther[prompt.question] = other;
    }
    return {
      behavior: 'allow',
      updatedInput: {
        answers: mappedAnswers,
        ...(Object.keys(mappedOther).length ? { otherAnswers: mappedOther } : {}),
      },
    };
  }
  const mapped: Record<string, string> = {};
  for (const prompt of prompts) {
    const key = request.name === 'AskUserQuestion' ? prompt.question : prompt.header;
    if (!key || Object.hasOwn(mapped, key)) throw new Error('无法唯一对应原生问题');
    const selected = answers[prompt.question] ?? [];
    const other = otherAnswers?.[prompt.question]?.trim();
    if (prompt.multiSelect && selected.some(label => /[,，]/.test(label))) throw new Error('多选标签包含分隔符，请在原会话回答');
    const parts = [...selected, ...(other ? [other] : [])];
    mapped[key] = parts.join(', ');
  }
  return { behavior: 'allow', updatedInput: { answers: mapped } };
}
