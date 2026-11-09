import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LegacyPluginStatus {
  enabled: boolean;
  /** 读不到或无法解析 config.json 时的说明；这时 enabled 为 true。 */
  problem: string | null;
}

/**
 * 同步读取 `<Paseo 目录>/config.json` 的 `plugins`，判断旧插件是否仍启用。
 * 额度来源 ID 重复会让整个实例停止，Provider 和来源又只能在启动时注册，升级通知重复发送也无法撤回，
 * 所以**只有文件不存在才算没启用**；其他读取或解析错误按“仍启用”处理并给出原因。
 */
export function legacyPluginStatus(home: string, pluginId: string): LegacyPluginStatus {
  let text: string;
  try { text = readFileSync(join(home, 'config.json'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { enabled: false, problem: null };
    return { enabled: true, problem: `无法读取 Paseo 的 config.json（${(error as NodeJS.ErrnoException).code ?? '未知错误'}），无法确认旧插件 ${pluginId} 是否停用，按旧插件仍启用处理` };
  }
  try {
    const config = JSON.parse(text) as { plugins?: Record<string, { enabled?: unknown } | null> };
    const entry = config.plugins?.[pluginId];
    return { enabled: !!entry && entry.enabled !== false, problem: null };
  } catch {
    return { enabled: true, problem: `Paseo 的 config.json 无法解析，无法确认旧插件 ${pluginId} 是否停用，按旧插件仍启用处理` };
  }
}

export const legacyPluginEnabled = (home: string, pluginId: string): boolean => legacyPluginStatus(home, pluginId).enabled;
