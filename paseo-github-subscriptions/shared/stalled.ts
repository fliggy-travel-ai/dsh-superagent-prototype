import { z } from 'zod';
import { defineRpc } from '@getpaseo/plugin';

export const StalledSnapshotSchema = z.object({
  sessions: z.array(z.object({
    agentId: z.string(), title: z.string(), since: z.string(),
    lastMessage: z.string().nullable(), messageError: z.string().nullable(),
  })),
  error: z.string().nullable(),
});
export type StalledSnapshot = z.infer<typeof StalledSnapshotSchema>;
export const stalledSnapshot = defineRpc({ name: 'todos.stalled', input: z.object({}), output: StalledSnapshotSchema });
