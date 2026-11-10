import { z } from 'zod';
import { defineRpc } from '@getpaseo/plugin';

export const StalledHostTimingsSchema = z.object({
  hostId: z.string(),
  listMs: z.number(),
  scheduleListMs: z.number(),
  subscriptionsMs: z.number().nullable(),
  totalMs: z.number(),
  cached: z.boolean().optional(),
});
export type StalledHostTimings = z.infer<typeof StalledHostTimingsSchema>;

export const StalledTimingsSchema = z.object({
  collectMs: z.number(),
  hosts: z.array(StalledHostTimingsSchema).optional(),
  subagentsMs: z.number(),
  messageMs: z.number(),
  currentMs: z.number(),
  liveIdsMs: z.number(),
  totalMs: z.number(),
});
export type StalledTimings = z.infer<typeof StalledTimingsSchema>;

export const StalledSnapshotSchema = z.object({
  sessions: z.array(z.object({
    agentId: z.string(), title: z.string(), since: z.string(),
    lastMessage: z.string().nullable(), messageError: z.string().nullable(),
  })),
  error: z.string().nullable(),
  scannedAt: z.string().nullable().optional(),
  timings: StalledTimingsSchema.optional(),
});
export type StalledSnapshot = z.infer<typeof StalledSnapshotSchema>;
export const stalledSnapshot = defineRpc({ name: 'todos.stalled', input: z.object({}), output: StalledSnapshotSchema });
