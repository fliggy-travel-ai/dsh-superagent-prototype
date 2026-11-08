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
    lateReceipt: z.boolean().optional(),
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
