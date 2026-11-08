import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

/**
 * 模块的运行时设置：页面写入 `<状态目录>/<模块>/settings.json`，只保存改过的项；
 * machine.json 的区块提供默认值。同步读写，写入走临时文件再改名，权限 0600。
 * 文件损坏或不合法时回到默认值，`error()` 给出原因，不覆盖原文件。
 */
export interface SettingsStore<T extends object> {
  read(): T;
  /** 只写传入的项。不合法时抛错，内存和文件都不变。 */
  update(patch: Partial<T>): T;
  error(): string | null;
}

export function createSettingsStore<T extends object>(path: string, partial: z.ZodType<Partial<T>>, defaults: T): SettingsStore<T> {
  let overrides: Partial<T> = {};
  let error: string | null = null;
  try {
    const text = readFileSync(path, 'utf8');
    try {
      const parsed = partial.safeParse(JSON.parse(text));
      if (parsed.success) overrides = parsed.data;
      else error = `设置文件不合法：${parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || '（根）'}：${issue.message}`).join('；')}`;
    } catch { error = '设置文件无法解析：不是合法的 JSON'; }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') error = `设置文件无法读取（${(cause as NodeJS.ErrnoException).code ?? '未知错误'}）`;
  }
  return {
    read: () => ({ ...defaults, ...overrides }),
    update(patch) {
      const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
      const next = partial.parse({ ...overrides, ...defined });
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
      renameSync(temp, path);
      overrides = next;
      error = null;
      return { ...defaults, ...overrides };
    },
    error: () => error,
  };
}
