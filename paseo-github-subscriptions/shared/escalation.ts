import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

/** 升级通知（模块 answer.escalation）的页面契约。RPC 约定见 #1737 评论 6728145308。 */
export const DeliverySchema = z.enum(['shadow', 'live']);
export const WindowDaysSchema = z.union([z.enum(['daily', 'weekdays', 'weekends']), z.array(z.number().int().min(0).max(6))]);
export const ImmediateWindowOutSchema = z.strictObject({ days: WindowDaysSchema, from: z.string(), to: z.string() });

export const EscalationSnapshotSchema = z.strictObject({
  enabled: z.boolean(),
  /** 异常时页面显示红色“没有运行”。 */
  status: z.enum(['running', 'stopped', 'error']),
  error: z.string().nullable(),
  delivery: DeliverySchema,
  timezone: z.string(),
  immediate: z.array(ImmediateWindowOutSchema),
  delayMinutes: z.number(),
  webhook: z.strictObject({ configured: z.boolean(), hostname: z.string().nullable(), fingerprint: z.string().nullable() }),
  pendingEvents: z.array(z.strictObject({
    id: z.string(), agentId: z.string(), sessionTitle: z.string(), workspaceId: z.string().nullable(),
    questionText: z.string(), notifiedAt: z.string(), delivery: DeliverySchema,
  })),
  recentDeliveries: z.array(z.strictObject({
    id: z.string(), agentId: z.string(), sessionTitle: z.string(), summary: z.string(), at: z.string(),
    delivery: DeliverySchema, status: z.enum(['delivered', 'recorded-shadow', 'failed']),
  })),
});
export type EscalationSnapshot = z.infer<typeof EscalationSnapshotSchema>;

export const EscalationConfigureSchema = z.strictObject({
  enabled: z.boolean().optional(),
  delivery: DeliverySchema.optional(),
  timezone: z.string().min(1).optional(),
  immediate: z.array(z.strictObject({ days: z.enum(['daily', 'weekdays', 'weekends']), from: z.string(), to: z.string() })).optional(),
  delayMinutes: z.number().int().min(0).optional(),
});

export const escalationSnapshot = defineRpc({ name: 'escalation.snapshot', input: z.object({}), output: EscalationSnapshotSchema });
export const escalationConfigure = defineRpc({ name: 'escalation.configure', input: EscalationConfigureSchema, output: EscalationSnapshotSchema });
export const escalationTestWebhook = defineRpc({ name: 'escalation.test-webhook', input: z.object({}), output: z.strictObject({ sent: z.boolean(), message: z.string() }) });
export const escalationWebhookConfigure = defineRpc({
  name: 'escalation.webhook.configure',
  input: z.strictObject({ url: z.string().min(1), auth: z.string().min(1).optional() }),
  output: z.strictObject({ configured: z.boolean(), hostname: z.string().nullable(), fingerprint: z.string().nullable() }),
});
export const escalationAcknowledge = defineRpc({
  name: 'escalation.acknowledge',
  input: z.strictObject({ id: z.string().min(1), agentId: z.string().optional() }),
  output: z.strictObject({ ok: z.boolean() }),
});
