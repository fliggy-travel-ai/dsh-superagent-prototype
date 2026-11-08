import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

export const DevelopmentToolSchema = z.enum(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
export const SessionPolicySchema = z.object({
  agentId: z.string().min(1).max(200), enabled: z.boolean(),
  tools: z.array(DevelopmentToolSchema).max(7),
  commands: z.array(z.string().trim().min(1).max(2000)).max(40),
  expiresAt: z.string().datetime().nullable().optional(),
  oneShot: z.boolean().optional(),
}).strict();
export type SessionPolicy = z.infer<typeof SessionPolicySchema>;
export const NativeSessionSchema = z.object({
  id: z.string(), title: z.string(), provider: z.string(), supportsAutomation: z.boolean(), mode: z.string().nullable(),
  status: z.string(), workspaceId: z.string().nullable(), workspacePath: z.string().nullable(),
  pending: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string(), title: z.string(), reason: z.string(), state: z.enum(['manual', 'automatic', 'submitted']).default('manual') })),
});
export const AutomationAuditSchema = z.object({
  id: z.string(), agentId: z.string(), requestId: z.string(), fingerprint: z.string(),
  title: z.string(), tool: z.string(), at: z.string(),
  status: z.enum(['submitted', 'resolved', 'unknown']),
  resolution: z.enum(['allow', 'deny', 'disappeared']).optional(),
});
export const AutomationStateSchema = z.object({
  version: z.literal(1), paused: z.boolean(), policies: z.array(SessionPolicySchema), audit: z.array(AutomationAuditSchema),
});
export const AutomationSnapshotSchema = z.object({
  hostName: z.string(), paused: z.boolean(), policies: z.array(SessionPolicySchema), sessions: z.array(NativeSessionSchema),
  audit: z.array(AutomationAuditSchema), error: z.string().nullable(), truncated: z.boolean(),
});
export type AutomationSnapshot = z.infer<typeof AutomationSnapshotSchema>;
export const automationSnapshot = defineRpc({ name: 'automation.snapshot', input: z.object({}), output: AutomationSnapshotSchema });
export const automationPause = defineRpc({ name: 'automation.pause', input: z.object({ paused: z.boolean() }), output: AutomationSnapshotSchema });
export const automationPolicy = defineRpc({ name: 'automation.policy', input: SessionPolicySchema, output: AutomationSnapshotSchema });
