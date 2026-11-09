import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUILTIN_USAGE_SOURCE_IDS,
  normalizeHideBuiltinId,
  normalizeUsagePins,
  type BuiltinUsageSourceId,
  type UsagePin,
} from '../../../shared/provider-quotas.ts';

export { normalizeHideBuiltinId, normalizeUsagePins, type UsagePin };

export interface UserPluginEntry {
  source: 'directory';
  path: string;
  enabled?: boolean;
}

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

/**
 * 读取磁盘上的用户插件列表，排除内置额度插件覆写项。
 */
export function readDiskUserPlugins(paseoHome: string): Record<string, UserPluginEntry> {
  const allBuiltinPluginIds = new Set(BUILTIN_USAGE_SOURCE_IDS.map(id => `${id}-usage-source`));
  const configPath = join(paseoHome, 'config.json');
  const filtered: Record<string, UserPluginEntry> = {};
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    if (raw?.plugins && typeof raw.plugins === 'object') {
      for (const [k, v] of Object.entries(raw.plugins)) {
        if (!allBuiltinPluginIds.has(k) && v && typeof v === 'object') {
          filtered[k] = v as UserPluginEntry;
        }
      }
    }
  } catch {
    // 忽略读取错误，回退扫描 local-plugins
  }
  const localPluginsDir = join(paseoHome, 'local-plugins');
  try {
    for (const entry of readdirSync(localPluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const pluginPath = join(localPluginsDir, entry.name);
      if (!existsSync(join(pluginPath, 'paseo-plugin.json'))) continue;
      if (!(entry.name in filtered)) {
        filtered[entry.name] = { source: 'directory', path: pluginPath, enabled: true };
      }
    }
  } catch {
    // 忽略缺失的 local-plugins 目录
  }
  return filtered;
}

/**
 * 按配置停用指定的 Paseo 内置额度插件（迁自 provider-quotas-usage-source）。
 */
export async function suppressBuiltinUsagePlugins(
  hideBuiltin: readonly string[],
  deps: {
    paseoHome: string;
    patchPlugins: (plugins: Record<string, UserPluginEntry>) => Promise<void>;
    disablePlugin: (pluginId: string) => Promise<void>;
  },
): Promise<{ disabledPluginIds: string[] }> {
  const pluginIds = builtinPluginIdsFor(hideBuiltin);
  if (pluginIds.length === 0) {
    return { disabledPluginIds: [] };
  }
  const userPlugins = readDiskUserPlugins(deps.paseoHome);
  const tempPlugins: Record<string, UserPluginEntry> = { ...userPlugins };
  for (const id of pluginIds) {
    tempPlugins[id] = {
      source: 'directory',
      path: `/Applications/Paseo.app/Contents/Resources/builtin-plugins/${id}`,
      enabled: false,
    };
  }
  await deps.patchPlugins(tempPlugins);
  for (const id of pluginIds) {
    await deps.disablePlugin(id).catch(() => undefined);
  }
  await deps.patchPlugins(userPlugins);
  return { disabledPluginIds: pluginIds };
}
