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
  /** 客户端是否已应用隐藏内置额度来源（过滤显示与侧栏固定项，不修改 config.json 的 plugins）。 */
  hideBuiltinApplied: z.boolean(),
  skippedConflicts: z.array(SkippedConflictSchema),
  reloadRequired: z.boolean(),
  error: z.string().nullable(),
});
export type ProviderQuotasSnapshot = z.infer<typeof ProviderQuotasSnapshotSchema>;

const BUILTIN_ID_SET = new Set<string>(BUILTIN_USAGE_SOURCE_IDS);
const EFFECTIVE_WINDOW_SOURCES = new Set<string>([
  'antigravity',
  'codex-multi',
  'cursor-cli',
  'grok-multi',
  'glm',
  'qoder',
]);

export interface UsagePin {
  sourceId: string;
  windowId: string;
}

/**
 * 将用户配置的内置额度来源标识（如 "codex" 或 "codex-usage-source"）规范化为短标识（如 "codex"）。
 */
export function normalizeHideBuiltinId(raw: string): BuiltinUsageSourceId | null {
  const trimmed = raw.trim().replace(/-usage-source$/u, '');
  if (BUILTIN_ID_SET.has(trimmed)) {
    return trimmed as BuiltinUsageSourceId;
  }
  return null;
}

/**
 * 按 hideBuiltin 配置过滤侧栏固定的额度项，并保持多窗口来源只固定 effective 窗口。
 */
export function normalizeUsagePins(
  pins: unknown,
  options: { hideBuiltin: readonly string[] },
): UsagePin[] | null {
  if (!Array.isArray(pins)) return null;
  const suppressed = new Set<string>();
  for (const item of options.hideBuiltin) {
    const normalized = normalizeHideBuiltinId(item);
    if (normalized) suppressed.add(normalized);
  }
  const filtered = pins.filter((pin): pin is UsagePin => {
    if (!pin || typeof pin !== 'object') return false;
    const { sourceId, windowId } = pin as { sourceId?: string; windowId?: string };
    if (typeof sourceId !== 'string' || typeof windowId !== 'string') return false;
    if (suppressed.has(sourceId)) return false;
    if (EFFECTIVE_WINDOW_SOURCES.has(sourceId) && windowId !== 'effective') return false;
    return true;
  });
  return filtered.length > 0 ? filtered : null;
}

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
