import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';

/**
 * 旧插件状态迁移：只复制，不移动、不删除；目标已存在的文件不覆盖，所以可以重复运行。
 * 新文件权限 0600，新目录 0700。旧目录保留到旧插件被删除为止。
 */
export interface LegacyEntry {
  /** 相对旧目录的路径。 */
  from: string;
  /** 相对新目录的路径，默认同名。 */
  to?: string;
  /** 整个目录递归复制。 */
  directory?: boolean;
}
export interface CopyReport {
  copied: string[];
  skipped: Array<{ path: string; reason: string }>;
  missing: string[];
}

const inside = (path: string) => !isAbsolute(path) && !normalize(path).split('/').includes('..');

function copyFile(source: string, target: string): boolean {
  if (existsSync(target)) return false;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(source, target);
  chmodSync(target, 0o600);
  return true;
}

function copyTree(source: string, target: string, relative: string, report: CopyReport) {
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(source)) {
    const from = join(source, name);
    const to = join(target, name);
    if (statSync(from).isDirectory()) copyTree(from, to, join(relative, name), report);
    else if (copyFile(from, to)) report.copied.push(join(relative, name));
    else report.skipped.push({ path: join(relative, name), reason: '目标已存在' });
  }
}

export function copyLegacyFiles(sourceDirectory: string, targetDirectory: string, entries: readonly LegacyEntry[]): CopyReport {
  const report: CopyReport = { copied: [], skipped: [], missing: [] };
  for (const entry of entries) {
    const destination = entry.to ?? entry.from;
    if (!inside(entry.from) || !inside(destination)) throw new Error(`迁移路径越出目录：${entry.from}`);
    const source = join(sourceDirectory, entry.from);
    const target = join(targetDirectory, destination);
    if (!existsSync(source)) { report.missing.push(entry.from); continue; }
    if (entry.directory) {
      if (!statSync(source).isDirectory()) { report.skipped.push({ path: entry.from, reason: '不是目录' }); continue; }
      copyTree(source, target, destination, report);
    } else if (copyFile(source, target)) report.copied.push(destination === entry.from ? entry.from : `${entry.from} → ${destination}`);
    else report.skipped.push({ path: entry.from, reason: '目标已存在' });
  }
  return report;
}
