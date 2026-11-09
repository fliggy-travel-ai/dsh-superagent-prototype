import { randomBytes } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function readRawMachineConfig(path: string): Promise<Record<string, unknown>> {
  try {
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { version: 1, ...(parsed as Record<string, unknown>) };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('machine.json 无法读取或不是合法的 JSON');
    }
  }
  return { version: 1 };
}

export async function patchMachineConfig(
  path: string,
  mutator: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const current = await readRawMachineConfig(path);
  const next = { version: 1, ...mutator(current) };
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600);
  return next;
}

const BACKUP_CANDIDATES = [
  'machine.json',
  'labels.json',
  'browser-state.json',
  'automation-state.json',
  'presence-state.json',
  'state.json',
] as const;

export async function exportMachineBackup(baseDirectory: string): Promise<{ backupPath: string; createdAt: string; files: string[] }> {
  const createdAt = new Date().toISOString();
  const stamp = createdAt.replace(/[:.]/g, '-');
  const backupPath = join(baseDirectory, 'backups', `backup-${stamp}`);
  await mkdir(backupPath, { recursive: true, mode: 0o700 });
  await chmod(backupPath, 0o700);
  const files: string[] = [];
  for (const name of BACKUP_CANDIDATES) {
    const src = join(baseDirectory, name);
    try {
      const info = await stat(src);
      if (info.isFile()) {
        const dest = join(backupPath, name);
        await copyFile(src, dest);
        await chmod(dest, 0o600);
        files.push(name);
      }
    } catch {
      // 文件不存在时跳过
    }
  }
  return { backupPath, createdAt, files };
}
