import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinCandidates, comparePaseoVendor, paseoVendorDirectory, paseoVendors } from '../scripts/paseo-vendor.ts';

const vendorRoot = fileURLToPath(new URL('../server/vendor', import.meta.url));

test('Paseo 自带文件的副本都存在，目录名带版本和自带插件名', () => {
  for (const vendor of paseoVendors) {
    assert.match(paseoVendorDirectory(vendorRoot, vendor), /server\/vendor\/paseo-\d+\.\d+\.\d+\/[a-z-]+$/);
    assert.deepEqual(comparePaseoVendor(vendorRoot, vendor, fileURLToPath(new URL('../server/vendor/paseo-0.15.0/claude-usage-source', import.meta.url))), []);
  }
});

test('与自带插件逐字比较：相同为空，内容不同或缺文件都算差异，找不到自带目录返回 null', () => {
  const root = mkdtempSync(join(tmpdir(), 'paseo-vendor-'));
  try {
    const vendor = { plugin: 'demo', version: '9.9.9', files: ['a.ts', 'sub/b.ts'] };
    const copy = paseoVendorDirectory(root, vendor);
    const builtin = join(root, 'builtin');
    for (const [base, a, b] of [[copy, 'A', 'B'], [builtin, 'A', 'B2']] as const) {
      mkdirSync(join(base, 'sub'), { recursive: true });
      writeFileSync(join(base, 'a.ts'), a); writeFileSync(join(base, 'sub', 'b.ts'), b);
    }
    assert.deepEqual(comparePaseoVendor(root, vendor, builtin), ['sub/b.ts']);
    rmSync(join(builtin, 'a.ts'));
    assert.deepEqual(comparePaseoVendor(root, vendor, builtin), ['a.ts', 'sub/b.ts']);
    assert.equal(comparePaseoVendor(root, vendor, join(root, 'missing')), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
  assert.deepEqual(builtinCandidates('x', '/r'), ['/r/builtin-plugins/x', '/r/builtin-plugins/x.disabled']);
});
