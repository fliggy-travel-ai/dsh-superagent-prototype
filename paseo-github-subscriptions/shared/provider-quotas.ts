import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

export const PROVIDER_QUOTA_SOURCE_IDS = [
  'opencode-token-switch',
  'antigravity',
  'codex-multi',
  'qoder',
  'glm',
  'cursor-cli',
  'grok-multi',
] as const;
export type ProviderQuotaSourceId = (typeof PROVIDER_QUOTA_SOURCE_IDS)[number];

export const BUILTIN_USAGE_SOURCE_IDS = [
  'codex',
  'cursor',
  'grok',
  'kimi',
  'zai',
] as const;
export type BuiltinUsageSourceId = (typeof BUILTIN_USAGE_SOURCE_IDS)[number];

export const SkippedConflictSchema = z.object({
  sourceId: z.string(),
  legacyPluginId: z.string(),
  reason: z.string(),
});
export type SkippedConflict = z.infer<typeof SkippedConflictSchema>;

export const ProviderQuotasSnapshotSchema = z.object({
  enabled: z.boolean(),
  enabledSources: z.array(z.string()),
  hideBuiltin: z.array(z.string()),
  skippedConflicts: z.array(SkippedConflictSchema),
  reloadRequired: z.boolean(),
  error: z.string().nullable(),
});
export type ProviderQuotasSnapshot = z.infer<typeof ProviderQuotasSnapshotSchema>;

export const ProviderQuotasConfigureInputSchema = z.object({
  enabled: z.boolean().optional(),
  enabledSources: z.array(z.string()).optional(),
  hideBuiltin: z.array(z.string()).optional(),
});
export type ProviderQuotasConfigureInput = z.infer<typeof ProviderQuotasConfigureInputSchema>;

export const providerQuotasSnapshot = defineRpc({
  name: 'provider-quotas.snapshot',
  input: z.object({}),
  output: ProviderQuotasSnapshotSchema,
});

export const providerQuotasConfigure = defineRpc({
  name: 'provider-quotas.configure',
  input: ProviderQuotasConfigureInputSchema,
  output: ProviderQuotasSnapshotSchema,
});
