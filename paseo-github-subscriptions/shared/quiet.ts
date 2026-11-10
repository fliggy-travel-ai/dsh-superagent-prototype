import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

/** 子会话免提醒和事件转发（模块 answer.quietChildren）的页面契约。RPC 约定见 #1737 评论 6728145308。 */
export const QuietSnapshotSchema = z.strictObject({
  enabled: z.boolean(),
  forwardEvents: z.boolean(),
  pinnedWorkspaceCount: z.number(),
  pinnedWorkspaces: z.array(z.strictObject({ id: z.string(), title: z.string() })),
  recentHandled: z.array(z.strictObject({
    id: z.string(),
    agentId: z.string(),
    sessionTitle: z.string(),
    eventKind: z.enum(['completed', 'failed']),
    clearedAttention: z.boolean(),
    forwardedTo: z.string().nullable(),
    forwardStatus: z.enum(['forwarded', 'no-parent', 'target-missing', 'disabled']),
    at: z.string(),
  })),
  error: z.string().nullable(),
});
export type QuietSnapshot = z.infer<typeof QuietSnapshotSchema>;

export const quietSnapshot = defineRpc({ name: 'quiet.snapshot', input: z.object({}), output: QuietSnapshotSchema });
export const quietConfigure = defineRpc({
  name: 'quiet.configure',
  input: z.strictObject({ enabled: z.boolean().optional(), forwardEvents: z.boolean().optional() }),
  output: QuietSnapshotSchema,
});
/** 跨主机转发时，对方主机用它重新解析“现任主会话”。 */
export const quietResolveMain = defineRpc({
  name: 'quiet.resolve-main',
  input: z.strictObject({ parentAgentId: z.string(), parentWorkspaceId: z.string().nullable().optional() }),
  output: z.strictObject({ agentId: z.string().nullable(), workspaceId: z.string().nullable() }),
});
