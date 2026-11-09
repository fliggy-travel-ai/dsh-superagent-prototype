import {
   normalizeHideBuiltinId,
  normalizeUsagePins,
  type UsagePin,
} from '../../../shared/provider-quotas.ts';

export { normalizeHideBuiltinId, normalizeUsagePins, type UsagePin };

/**
 * 将短内置来源标识列表映射为 Paseo 内置插件 ID（如 "codex-usage-source"）。
 */
export function builtinPluginIdsFor(hideBuiltin: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of hideBuiltin) {
    const normalized = normalizeHideBuiltinId(item);
    if (!normalized) continue;
    const pluginId = `${normalized}-usage-source`;
    if (!seen.has(pluginId)) {
      seen.add(pluginId);
      result.push(pluginId);
    }
  }
  return result;
}
