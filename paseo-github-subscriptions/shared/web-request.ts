import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

export type WebRequestContext = {
  webSessionId: string;
  toolUseId: string;
  expected: { toolName: string; input: Record<string, unknown> };
};

export type WebRequestAnswer = WebRequestContext & (
  | { kind: 'question'; answers: Record<string, string | string[]>; otherAnswers?: Record<string, string> }
  | { kind: 'tool'; decision: 'allow' | 'deny' }
);

export type WebRequestResult =
  | { status: 'submitted' }
  | { status: 'page_not_open' }
  | { status: 'unknown'; detail: string };

export type AnswerWebRequest = (request: WebRequestAnswer) => Promise<WebRequestResult>;

const DETAIL_REASONS: Record<string, string> = {
  unsupported_tool: '不是 AskUserQuestion',
  dismissed: '已在 Paseo 忽略',
  invalid_answer: '答案对不上原问题',
  request_changed: '原请求已变化',
  answer_changed: '回答已变化',
  bridge_not_connected: '配对浏览器未连接',
  scan_stale: '浏览器扫描不新鲜',
  not_found: '页面上找不到对应提问',
  scan_incomplete: '页面扫描不完整',
  multiple_candidates: '页面上有多个候选提问',
  other_not_on_page: '页面上该题没有其他输入框',
  not_claimed: '浏览器未及时领取',
  no_receipt: '未收到浏览器回执',
  page_unknown: '扩展复核未通过',
};

export function webRequestDetailReason(detail: string): string {
  return DETAIL_REASONS[detail] ?? (detail || '未知原因');
}

export type CloudRequestOutcome = 'answered' | 'denied' | 'canceled';

export type ResolveWebRequest = (input: {
  webSessionId: string;
  toolUseId: string;
  outcome: CloudRequestOutcome;
}) => void;

export const WebRequestSourceSchema = z.enum(['user', 'automatic', 'paseo']);
export type WebRequestSource = z.infer<typeof WebRequestSourceSchema>;

export const WebRequestAnswerSummarySchema = z.strictObject({
  digest: z.string(),
  answers: z.record(z.string(), z.array(z.string())).optional(),
  other: z.record(z.string(), z.strictObject({ length: z.number().int().nonnegative(), sha256: z.string() })).optional(),
  decision: z.enum(['allow', 'deny']).optional(),
});
export type WebRequestAnswerSummary = z.infer<typeof WebRequestAnswerSummarySchema>;

export const WebRequestAuditEntrySchema = z.strictObject({
  webSessionId: z.string(),
  toolUseId: z.string(),
  kind: z.enum(['question', 'tool']),
  answerSummary: WebRequestAnswerSummarySchema,
  answerReceived: z.strictObject({
    at: z.string(),
    source: WebRequestSourceSchema,
  }),
  webSubmitted: z.strictObject({
    at: z.string(),
    instanceId: z.string().nullable().optional(),
    status: z.enum(['submitted', 'unknown']),
    detail: z.string().optional(),
    // 旧版本把迟到回执写在这里并覆盖首个结果；保留字段只为读取旧记录。
    lateReceipt: z.boolean().optional(),
  }).optional(),
  // 首个网页结果之后才到的扩展回执；webSubmitted 保持首个结果不变。
  lateReceipt: z.strictObject({
    at: z.string(),
    status: z.enum(['submitted', 'unknown']),
    detail: z.string().optional(),
  }).optional(),
  cloudConfirmed: z.strictObject({
    at: z.string(),
    outcome: z.enum(['answered', 'denied', 'canceled']),
  }).optional(),
});
export type WebRequestAuditEntry = z.infer<typeof WebRequestAuditEntrySchema>;

export const WebRequestAuditSnapshotSchema = z.strictObject({
  entries: z.array(WebRequestAuditEntrySchema).max(300),
});
export type WebRequestAuditSnapshot = z.infer<typeof WebRequestAuditSnapshotSchema>;

export const webRequestAudit = defineRpc({
  name: 'web-request.audit',
  input: z.object({}),
  output: WebRequestAuditSnapshotSchema,
});
