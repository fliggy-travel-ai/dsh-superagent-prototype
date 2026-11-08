import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

export const CloudSessionStatusSchema = z.strictObject({
  enabled: z.boolean(),
  onlineSessions: z.number().int().nonnegative(),
  unackedMessages: z.number().int().nonnegative(),
});
export type CloudSessionStatus = z.infer<typeof CloudSessionStatusSchema>;

export const ProvidersInstanceStatusSchema = z.strictObject({
  instanceState: z.enum(['running', 'stopped', 'error', 'legacy']),
  instanceError: z.string().nullable(),
  runningSessionsCount: z.number().int().nonnegative(),
  providers: z.array(z.strictObject({
    id: z.string(),
    label: z.string(),
    available: z.boolean(),
    runningSessions: z.number().int().nonnegative(),
  })),
  cloudSession: CloudSessionStatusSchema,
});
export type ProvidersInstanceStatus = z.infer<typeof ProvidersInstanceStatusSchema>;

export const cloudSessionStatus = defineRpc({
  name: 'cloud-session.status',
  input: z.object({}),
  output: CloudSessionStatusSchema,
});

export const providersInstanceStatus = defineRpc({
  name: 'providers.instance.status',
  input: z.object({}),
  output: ProvidersInstanceStatusSchema,
});
