import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 插件安装目录。Paseo 0.15 运行插件时不提供插件目录，server 包作为 `eval` 出的 CommonJS 函数执行，
 * import.meta.url 和 __dirname 都不可用（#1737）。目录安装的插件在 Paseo 配置 `plugins.<插件 ID>.path` 里有记录。
 */
export function pluginInstallDirectory(pluginId: string, home = process.env.PASEO_HOME ?? join(homedir(), '.paseo')): string | null {
  try {
    const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as { plugins?: Record<string, { source?: string; path?: unknown }> };
    const entry = config.plugins?.[pluginId];
    return entry?.source === 'directory' && typeof entry.path === 'string' && entry.path ? entry.path : null;
  } catch { return null; }
}

/** 浏览器扩展目录（设置页提示“加载已解压的扩展”时显示）。`PASEO_GHSUB_EXTENSION_PATH` 优先；找不到时返回 null。 */
export function extensionDirectory(pluginId: string, home?: string, env: Record<string, string | undefined> = process.env): string | null {
  if (env.PASEO_GHSUB_EXTENSION_PATH) return env.PASEO_GHSUB_EXTENSION_PATH;
  const directory = pluginInstallDirectory(pluginId, home);
  const extension = directory ? join(directory, 'browser-extension') : null;
  return extension && existsSync(extension) ? extension : null;
}
