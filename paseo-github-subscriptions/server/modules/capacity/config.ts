import { z } from 'zod';
export const CapacitySchema = z.strictObject({
  accounts: z.record(z.string(), z.object({ tier: z.enum(['max', 'pro']) })).default({}),
  warmup: z.array(z.string()).default([]),
  liveMaxAgeMinutes: z.number().positive().default(10),
  pace: z.boolean().default(true),
  migration: z.strictObject({ mode: z.enum(['off', 'shadow', 'live']).default('off'), handoffTemplate: z.string().optional() }).default({ mode: 'off' }),
});
export type CapacityConfig = z.infer<typeof CapacitySchema>;
export const CAPACITY_DEFAULT = CapacitySchema.parse({});
