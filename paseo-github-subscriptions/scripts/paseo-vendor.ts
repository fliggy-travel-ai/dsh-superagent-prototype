import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 复制自 Paseo 自带插件的文件：原样复制，保持相对路径，放在 `server/vendor/paseo-<版本>/<自带插件名>/`。
 * Paseo 升级后，用 `npm run vendor:check -- --paseo-builtin <自带插件目录>`（不写目录时自动在
 * /Applications/Paseo.app 里找）比较，有差异就重新复制。
 */
export interface PaseoVendor {
  /** 自带插件名，也是 vendor 下的目录名。 */
  plugin: string;
  version: string;
  files: string[];
}

export const paseoVendors: PaseoVendor[] = [
  { plugin: 'claude-usage-source', version: '0.15.0', files: ['server/usage.ts', 'server/stores.ts', 'shared/input.ts', 'icon.svg'] },
];

export const paseoVendorDirectory = (vendorRoot: string, vendor: PaseoVendor) => join(vendorRoot, `paseo-${vendor.version}`, vendor.plugin);

/** 停用的自带插件目录加了 `.disabled` 后缀，两种名字都找。 */
export function builtinCandidates(plugin: string, resources = '/Applications/Paseo.app/Contents/Resources'): string[] {
  const base = join(resources, 'builtin-plugins', plugin);
  return [base, `${base}.disabled`];
}

/** 返回与 Paseo 自带文件不一致的相对路径。找不到自带插件目录时返回 null（例如 CI 里没有装 Paseo）。 */
export function comparePaseoVendor(vendorRoot: string, vendor: PaseoVendor, builtinDirectory?: string): string[] | null {
  const builtin = builtinDirectory ?? builtinCandidates(vendor.plugin).find(candidate => existsSync(candidate));
  if (!builtin || !existsSync(builtin)) return null;
  const copy = paseoVendorDirectory(vendorRoot, vendor);
  return vendor.files.filter(file => {
    try { return readFileSync(join(copy, file), 'utf8') !== readFileSync(join(builtin, file), 'utf8'); } catch { return true; }
  });
}
