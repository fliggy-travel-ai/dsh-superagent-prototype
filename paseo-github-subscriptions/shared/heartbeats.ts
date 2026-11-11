import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

export const HeartbeatSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  prompt: z.string(),
  cron: z.string(),
  timezone: z.string().nullable(),
  status: z.enum(['active', 'paused']),
  createdAt: z.string(),
  updatedAt: z.string(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  maxRuns: z.number().int().positive().nullable(),
  runCount: z.number().int().nonnegative(),
});

export type Heartbeat = z.output<typeof HeartbeatSchema>;

export const HeartbeatCountSchema = z.object({
  agentId: z.string(),
  /** 有效（未暂停）的心跳数量。 */
  count: z.number().int().nonnegative(),
  /** 已暂停的心跳数量，暂停的心跳不会唤醒代理。 */
  paused: z.number().int().nonnegative(),
});

export type HeartbeatCount = z.output<typeof HeartbeatCountSchema>;

const AgentInputSchema = z.object({ agentId: z.string().trim().min(1) });
const ScheduleInputSchema = z.object({
  agentId: z.string().trim().min(1),
  prompt: z.string().trim().min(1).max(50_000),
  cron: z.string().trim().min(1).max(500),
  timezone: z.string().trim().min(1).max(200).nullable(),
  maxRuns: z.number().int().positive().nullable(),
});
const HeartbeatListSchema = z.object({ heartbeats: z.array(HeartbeatSchema) });
const HeartbeatCountsSchema = z.object({ counts: z.array(HeartbeatCountSchema) });

export const listHeartbeatCounts = defineRpc({
  name: 'heartbeats.counts',
  input: z.object({}),
  output: HeartbeatCountsSchema,
});

export const listHeartbeats = defineRpc({
  name: 'heartbeats.list',
  input: AgentInputSchema,
  output: HeartbeatListSchema,
});

export const createHeartbeat = defineRpc({
  name: 'heartbeats.create',
  input: ScheduleInputSchema,
  output: HeartbeatListSchema,
});

export const updateHeartbeat = defineRpc({
  name: 'heartbeats.update',
  input: ScheduleInputSchema.extend({ id: z.string().trim().min(1) }),
  output: HeartbeatListSchema,
});

export const deleteHeartbeat = defineRpc({
  name: 'heartbeats.delete',
  input: AgentInputSchema.extend({ id: z.string().trim().min(1) }),
  output: HeartbeatListSchema,
});
