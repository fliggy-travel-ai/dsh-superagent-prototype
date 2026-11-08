import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const BrowserUsageWindowSchema = z.strictObject({ usedPct: z.number().min(0).max(100), resetsAt: z.string().datetime().nullable(), observedAt: z.string().datetime() });
export const BrowserUsagePostSchema = z.strictObject({
  instanceId: id,
  instanceName: z.string().trim().min(1).max(120).default('未命名浏览器环境'),
  adspowerProfile: z.string().trim().min(1).max(120).optional(),
  account: z.string().max(320).nullable().optional(),
  status: z.enum(['pending', 'ok', 'signed_out', 'failed']),
  reason: z.enum(['no_window', 'parse', 'timeout', 'challenge', 'tab_closed']).optional(),
  observedAt: z.string().datetime(),
  fiveHour: BrowserUsageWindowSchema.nullable(),
  weekly: BrowserUsageWindowSchema.nullable(),
}).transform(({ account: _account, ...rest }) => rest);
export const BrowserUsageApiKeySourceSchema = z.enum(['plugin', 'env', 'none']);
export const BrowserUsageSettingsSchema = z.strictObject({
  adspowerApiKeyConfigured: z.boolean(),
  adspowerApiKeySource: BrowserUsageApiKeySourceSchema.default('none'),
});
export const BrowserUsageApiKeyInputSchema = z.strictObject({
  apiKey: z.string().trim().min(1).max(512),
});
export type BrowserUsageWindow = z.infer<typeof BrowserUsageWindowSchema>;
export type BrowserUsagePost = z.infer<typeof BrowserUsagePostSchema>;
export type BrowserUsageApiKeySource = z.infer<typeof BrowserUsageApiKeySourceSchema>;
export type BrowserUsageSettings = z.infer<typeof BrowserUsageSettingsSchema>;
export type BrowserUsageApiKeyInput = z.infer<typeof BrowserUsageApiKeyInputSchema>;
