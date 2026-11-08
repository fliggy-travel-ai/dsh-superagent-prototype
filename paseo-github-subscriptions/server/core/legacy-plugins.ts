import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 同步读取 `<Paseo 目录>/config.json` 的 `plugins`，判断旧插件是否仍启用。
 * 额度来源 ID 重复会让整个实例停止，Provider 和来源又只能在启动时注册，所以只能这样自检。
 * 读不到或无法解析时按“没有启用”处理。
 */
export function legacyPluginEnabled(home: string, pluginId: string): boolean {
  try {
    const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as { plugins?: Record<string, { enabled?: unknown } | null> };
    const entry = config.plugins?.[pluginId];
    return !!entry && entry.enabled !== false;
  } catch { return false; }
}
