import { z } from 'zod';
import { BrowserQuestionSchema } from './presence.ts';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const BrowserSettingsSchema = z.strictObject({ enabled: z.boolean().default(false), port: z.number().int().min(1).max(65535).default(17373) });
export const BrowserBindingInputSchema = z.strictObject({ instanceId: id, sessionId: id, agentId: id.nullable() });
export const BrowserPairingSchema = z.strictObject({ url: z.string().url(), token: z.string().min(1) });
export const BrowserApprovalSchema = z.strictObject({ sessionId: id, reservationId: z.string().min(1).max(128), digest: z.string().regex(/^[a-f0-9]{64}$/), button: z.string().max(100), at: z.string().datetime(), observedAt: z.string().datetime().optional(), status: z.enum(['reserved', 'dismissed', 'still-visible', 'skipped']), readGate: z.enum(['read_gate_scrolled', 'read_gate_blocked']).optional() });
// 同步请求里的点同意记录：扩展可能比插件新（部署顺序错位），未知字段丢弃、未知的 readGate 取值忽略，不整条拒绝同步。
const BrowserApprovalInputSchema = z.object({ ...BrowserApprovalSchema.shape, readGate: BrowserApprovalSchema.shape.readGate.catch(undefined) });
export const BrowserApprovalEventSchema = BrowserApprovalSchema.extend({ instanceId: id, instanceName: z.string().max(120) });
export const BrowserActivitySchema = z.strictObject({ state: z.enum(['working', 'waiting', 'limited', 'unknown']), reason: z.string().max(300), lastMessage: z.string().max(2000), observedAt: z.string().datetime() });
export const BrowserInstanceInfoSchema = z.strictObject({
  instanceId: id,
  instanceName: z.string().min(1).max(120),
  account: z.string().nullable().default(null),
  connected: z.boolean(),
  lastSeenAt: z.string(),
});
export type BrowserInstanceInfo = z.infer<typeof BrowserInstanceInfoSchema>;

export const BrowserSnapshotSchema = z.strictObject({
  settings: BrowserSettingsSchema, connected: z.boolean(), error: z.string().nullable(),
  sessions: z.array(z.strictObject({ instanceId: id, instanceName: z.string().min(1).max(120), sessionId: id, title: z.string(), url: z.string(), tabCount: z.number().int().positive(), lastSeenAt: z.string(), agentId: id.nullable(), groupTitle: z.string(), activity: BrowserActivitySchema.optional() })),
  bindings: z.array(z.strictObject({ instanceId: id, sessionId: id, agentId: id })),
  approvals: z.array(BrowserApprovalEventSchema).optional(),
  extensionPath: z.string().optional(),
  instances: z.array(BrowserInstanceInfoSchema).optional(),
});
export type BrowserSettings = z.infer<typeof BrowserSettingsSchema>;
export type BrowserBindingInput = z.infer<typeof BrowserBindingInputSchema>;
export type BrowserPairing = z.infer<typeof BrowserPairingSchema>;
export type BrowserSnapshot = z.infer<typeof BrowserSnapshotSchema>;

export const BrowserSyncSchema = z.strictObject({ instanceId: id, instanceName: z.string().trim().min(1).max(120).default('未命名浏览器环境'), sessions: z.array(z.strictObject({
  sessionId: id, title: z.string().max(120), url: z.string().max(512), tabCount: z.number().int().min(1).max(10000), activity: BrowserActivitySchema.optional(),
})).max(500), approvals: z.array(BrowserApprovalInputSchema).max(30).default([]), observedSessionIds: z.array(id).max(500).default([]), questions: z.array(BrowserQuestionSchema).max(50).default([]), results: z.array(z.strictObject({ id: z.string().max(200), sessionId: id, fingerprint: z.string().max(128), status: z.enum(['submitted', 'unknown']) })).max(50).default([]) });
export * from './web-request.ts';
