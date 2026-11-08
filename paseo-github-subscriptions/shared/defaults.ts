import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { AgentDefaultRuleSchema, AgentDefaultsSchema, type AgentDefaultRule } from '../server/modules/providers-defaults/rules.ts';

export { AgentDefaultRuleSchema, AgentDefaultsSchema, type AgentDefaultRule };

export const DefaultsSnapshotSchema = z.strictObject({
  enabled: z.boolean(),
  rules: AgentDefaultsSchema,
  error: z.string().nullable(),
});
export type DefaultsSnapshot = z.infer<typeof DefaultsSnapshotSchema>;

export const DefaultsSaveInputSchema = z.strictObject({
  enabled: z.boolean().optional(),
  rules: AgentDefaultsSchema.optional(),
});
export type DefaultsSaveInput = z.infer<typeof DefaultsSaveInputSchema>;

export const defaultsSnapshot = defineRpc({
  name: 'defaults.snapshot',
  input: z.object({}),
  output: DefaultsSnapshotSchema,
});

export const defaultsSave = defineRpc({
  name: 'defaults.save',
  input: DefaultsSaveInputSchema,
  output: DefaultsSnapshotSchema,
});
