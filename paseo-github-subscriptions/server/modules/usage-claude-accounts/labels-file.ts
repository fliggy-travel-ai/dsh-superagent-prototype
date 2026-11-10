import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 账号显示标签 `labels.json`：Anthropic 返回的邮箱（Apple 登录是隐藏邮箱）对应到显示名称。权限 0600。 */
export function readLabels(file: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('无法读取账号显示标签：', String(error));
    return {};
  }
}

function write(file: string, labels: Record<string, string>) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(labels, null, 2), { mode: 0o600 });
  renameSync(temp, file);
}

/** 写入或删除（value 为 null）一条标签。 */
export function setLabel(file: string, key: string, value: string | null) {
  const labels = readLabels(file);
  if (value === null) delete labels[key]; else labels[key] = value;
  write(file, labels);
}

/** 把旧文件里的标签并入，已有的标签不覆盖。返回新增条数；旧文件不存在或损坏时返回 0。 */
export function mergeLabels(legacyFile: string, file: string): number {
  let legacy: Record<string, string>;
  try {
    const parsed = JSON.parse(readFileSync(legacyFile, 'utf8')) as Record<string, unknown>;
    legacy = Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch { return 0; }
  const current = readLabels(file);
  let added = 0;
  for (const [key, value] of Object.entries(legacy)) if (!(key in current)) { current[key] = value; added++; }
  if (added) write(file, current);
  return added;
}
