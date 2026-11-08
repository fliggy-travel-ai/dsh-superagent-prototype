import { createHash } from 'node:crypto';
import type { AgentPermissionRequest, AgentPermissionResponse } from '@getpaseo/protocol/agent-types';
import { QuestionPromptSchema, type QuestionPrompt, type QuestionAnswer } from '../shared/presence.ts';

export const questionFingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function nativePrompts(request: AgentPermissionRequest): QuestionPrompt[] | null {
  if (request.kind !== 'question' || !['AskUserQuestion', 'request_user_input', 'request_user_input_async'].includes(request.name)) return null;
  const input = request.input as { questions?: unknown } | undefined;
  if (!Array.isArray(input?.questions) || !input.questions.length || input.questions.length > 10) return null;
  if (input.questions.some(prompt => !prompt || typeof prompt !== 'object' || Array.isArray(prompt) ||
    Array.isArray(prompt.options) && prompt.options.some((option: unknown) => !option || typeof option !== 'object' || Array.isArray(option)))) return null;
  const parsed = QuestionPromptSchema.array().safeParse(input.questions.map(prompt => ({
    question: prompt.question, ...(typeof prompt.header === 'string' ? { header: prompt.header } : {}),
    multiSelect: prompt.multiSelect === true,
    options: Array.isArray(prompt.options) ? prompt.options.map((option: Record<string, unknown>) => ({
      label: option.label, description: option.description ?? '',
      recommended: option.recommended === true || typeof option.label === 'string' && /(?:\(recommended\)|（推荐）|\(推荐\)|\[recommended\])\s*$/i.test(option.label),
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

export function automaticAnswerBlockReason(prompts: QuestionPrompt[]): string | null {
  for (const prompt of prompts) {
    const text = [prompt.question, prompt.header ?? '', ...prompt.options.flatMap(option => [option.label, option.description])].join('\n');
    if (/(?:验收(?:方式|结论|通过)|按[^\n]{0,60}证据验收|确认[^\n]{0,30}验收|先合并|合并[^\n]{0,40}(?:PR|拉取请求)|(?:PR|拉取请求)[^\n]{0,40}合并|\b(?:acceptance\s+(?:sign.?off|approval)|(?:approve|merge)[^\n]{0,40}(?:PR\b|pull\s+request)))/i.test(text)) return '问题涉及验收或合并授权，请用户本人确认';
    if (/(?:验证码|两步验证|双重验证|安全验证|登录|登陆|扩大权限|提升权限|授予.*权限|绕过.*审批|关闭.*安全|one.time.password|\b(?:MFA|2FA|OTP|login|log\s*in|sign\s*in)\b|bypass.*permission|disable.*safeguard|(?:grant|expand|elevate).*\b(?:access|permission|privilege))/i.test(text)) return '问题涉及登录、验证或访问权限，请人工确认';
    if (/(?:转账|付款|支付|扣款|退款|充值|购买|订阅付费|\b(?:payment|purchase|refund|transfer\s+(?:money|funds)|charge\s+(?:card|account))\b)/i.test(text)) return '问题涉及资金操作，请人工确认';
    const cleanup = /(?:删除|清理|清空|释放|销毁|移除|丢弃|归档|\b(?:delet\w*|clean\w*|purge|releas\w*|destroy\w*|remov\w*|discard\w*|archiv\w*|decommission\w*)\b)/i.test(text);
    const resource = /(?:沙箱|工作树|分支|未提交|未推送|改动|数据|目录|文件|日志|证据|备份|账号|账户|云资源|环境|数据库|\b(?:sandbox\w*|worktree\w*|branch\w*|uncommitted|unpushed|changes|data|director\w*|files?|logs?|evidence|backups?|accounts?|environment\w*|database\w*|cloud\s+resources?)\b)/i.test(text);
    if (cleanup && resource || /(?:\brm\s+-[a-z]*r|\bgit\s+(?:clean|reset\s+--hard|worktree\s+remove)|永久删除|全部丢弃)/i.test(text)) return '问题涉及资源清理、释放或改动丢弃，请人工确认';
  }
  return null;
}

export function recommendedAnswers(prompts: QuestionPrompt[]): QuestionAnswer['answers'] | null {
  if (automaticAnswerBlockReason(prompts)) return null;
  const answers: QuestionAnswer['answers'] = {};
  for (const prompt of prompts) {
    const options = prompt.options.filter(option => option.recommended);
    if (!options.length || !prompt.multiSelect && options.length !== 1) return null;
    answers[prompt.question] = options.map(option => option.label);
  }
  try { validateAnswers(prompts, answers); return answers; } catch { return null; }
}

export function nativeResponse(request: AgentPermissionRequest, answers: QuestionAnswer['answers']): AgentPermissionResponse {
  const prompts = nativePrompts(request);
  if (!prompts) throw new Error('此请求不是受支持的问答');
  validateAnswers(prompts, answers);
  const mapped: Record<string, string> = {};
  for (const prompt of prompts) {
    const key = request.name === 'AskUserQuestion' ? prompt.question : prompt.header;
    if (!key || Object.hasOwn(mapped, key)) throw new Error('无法唯一对应原生问题');
    if (prompt.multiSelect && answers[prompt.question].some(label => /[,，]/.test(label))) throw new Error('多选标签包含分隔符，请在原会话回答');
    mapped[key] = answers[prompt.question].join(', ');
  }
  return { behavior: 'allow', updatedInput: { answers: mapped } };
}
