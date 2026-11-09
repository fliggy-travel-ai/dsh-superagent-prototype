import { chmodSync, constants, copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

/**
 * 直接改 `<Paseo 目录>/config.json` 的 Provider 条目。守护进程的 `config.patch` 只会保存 Provider 的
 * `enabled`、`additionalModels`、`paseoTools`，不保存 `extends`、`env`、`models`、`label`，所以新建 Provider 和
 * 改显示名称都要直接写文件（与额度名称的做法一致），写完再让 Paseo 重载。
 * 写入前备份（名字精确到毫秒，不覆盖），原子写入，写后读回核对。
 */
const stamp = (now: number) => new Date(now).toISOString().replace(/[-:]/g, '').replace('.', '').replace('Z', '');

/** 备份任意文件，返回备份路径。名字精确到毫秒；同一毫秒再备份时加序号，绝不覆盖已有备份。权限 0600。 */
export function backupFile(source: string, now: () => number = Date.now): string {
  const base = `${source}.bak-${stamp(now())}`;
  for (let index = 0; index < 1000; index++) {
    const target = index === 0 ? base : `${base}-${index}`;
    try { copyFileSync(source, target, constants.COPYFILE_EXCL); chmodSync(target, 0o600); return target; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  throw new Error(`${basename(source)} 备份名称冲突次数过多`);
}

export const backupConfigFile = (home: string, now: () => number = Date.now): string => backupFile(join(home, 'config.json'), now);

/** 严格读取 JSON：文件不存在返回 null；存在但无法读取或解析时抛错——不能把损坏的文件当作空对象写回。 */
export function readJsonStrict(path: string): any | null {
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`无法读取 ${basename(path)}（${(error as NodeJS.ErrnoException).code ?? '未知错误'}），没有写入`);
  }
  try { return JSON.parse(text); } catch { throw new Error(`${basename(path)} 无法解析：不是合法的 JSON，没有写入`); }
}

/** 原子写入 JSON（临时文件再改名），权限 0600。 */
export function writeJsonFile(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/** 用备份文件的内容原子地恢复原文件。 */
export function restoreFromBackup(backup: string, path: string): void {
  const temp = `${path}.${process.pid}.restore`;
  copyFileSync(backup, temp);
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

type Providers = Record<string, Record<string, unknown>>;

function readConfig(home: string): { config: { agents?: { providers?: Providers } }; path: string } {
  const path = join(home, 'config.json');
  try { return { config: JSON.parse(readFileSync(path, 'utf8')), path }; }
  catch (error) { throw new Error(`无法读取或解析 Paseo 的 config.json（${(error as NodeJS.ErrnoException).code ?? '内容不是合法 JSON'}），没有写入`); }
}

/** 把条目合并进 `agents.providers[id]`（顶层键整体替换，未提到的键保留）。 */
export function writeProviderEntry(home: string, id: string, entry: Record<string, unknown>): void {
  const { config, path } = readConfig(home);
  config.agents ??= {};
  config.agents.providers ??= {};
  config.agents.providers[id] = { ...config.agents.providers[id], ...entry };
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
  renameSync(temp, path);
}

/** 读回核对：条目里的每个键都要和文件里一致。不一致时报错，并提示用备份恢复。 */
export function verifyProviderEntry(home: string, id: string, entry: Record<string, unknown>, backupPath: string | null): void {
  const stored = readConfig(home).config.agents?.providers?.[id] ?? {};
  for (const [key, value] of Object.entries(entry)) {
    if (!isDeepStrictEqual(stored[key], value)) {
      throw new Error(`写入后读回不一致（${key}）。配置可能被其他程序改动${backupPath ? `，可用备份 ${backupPath} 恢复` : ''}`);
    }
  }
}
