import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { atomicWrite } from '../storage.ts';

// 云端请求表的落盘：插件重载、Paseo 重启后仍认得已关闭的编号（墓碑），未关闭的请求可以重新显示（#1737 评论 6734539343）。

export const STORED_REQUEST_MAX = 500;
export const CLOSED_TTL_MS = 7 * 24 * 60 * 60_000;

const StoredRequestSchema = z.object({
  cloud: z.string().min(1),
  toolUseId: z.string().min(1),
  closed: z.boolean(),
  openedAt: z.number(),
  closedAt: z.number().optional(),
  imported: z.boolean().optional(),
  // 由“关闭未知编号”产生的墓碑：不算一次真实的请求
  tombstone: z.boolean().optional(),
  request: z.object({
    toolUseId: z.string(),
    toolName: z.string(),
    kind: z.enum(['question', 'tool']),
    input: z.record(z.string(), z.unknown()),
  }).optional(),
});
export type StoredRequest = z.infer<typeof StoredRequestSchema>;
const StoredStateSchema = z.object({ version: z.literal(1), entries: z.array(StoredRequestSchema) });

export interface CloudRequestStore {
  load(): StoredRequest[];
  save(entries: StoredRequest[]): Promise<void>;
}

export function fileRequestStore(path: string): CloudRequestStore {
  let writes: Promise<unknown> = Promise.resolve();
  return {
    load() {
      try {
        const parsed = StoredStateSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
        return parsed.success ? parsed.data.entries : [];
      } catch { return []; }
    },
    save(entries) {
      const content = JSON.stringify({ version: 1, entries });
      const next = writes.then(() => atomicWrite(path, content));
      writes = next.catch(() => {});
      return next;
    },
  };
}
