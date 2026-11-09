import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPluginBoundaries } from '../scripts/check-plugin-boundaries.ts';

// #1737：Paseo 0.15 插件编译器拒绝 shared/ 引入 server/（热更新时构建失败）。检查规则与编译器一致。

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function plugin(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-boundaries-'));
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', allowImportingTsExtensions: true, noEmit: true } }));
  for (const [name, content] of Object.entries(files)) { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), content); }
  return { dir, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('插件源码没有越界引用（与 Paseo 0.15 插件编译器规则一致）', () => {
  assert.deepEqual(checkPluginBoundaries(root), []);
});

test('边界检查发现 shared 引入 server、client 引入 server、引入目录外的文件、shared 引入 Node 模块和类型导入越界', () => {
  const p = plugin({
    'index.server.ts': "import { a } from './shared/a.ts'; import { s } from './scripts/lib.ts'; export default () => [a, s];\n",
    'index.client.tsx': "import { b } from './shared/b.ts'; import type { T } from './server/types.ts'; export const x: T = b;\n",
    'shared/a.ts': "import { rule } from '../server/rules.ts'; export const a = rule;\n",
    'shared/b.ts': "import { join } from 'node:path'; export const b = join('a', 'b');\n",
    'server/rules.ts': 'export const rule = 1;\n',
    'server/types.ts': 'export type T = string;\n',
    'scripts/lib.ts': 'export const s = 1;\n',
  });
  try {
    assert.deepEqual(checkPluginBoundaries(p.dir), [
      'Node module cannot be imported into the plugin shared bundle: node:path imported by shared/b.ts',
      'Plugin modules belong in client/, server/, or shared/: scripts/lib.ts',
      'server-only module cannot be imported into the plugin client bundle: server/types.ts',
      'server-only module cannot be imported into the plugin shared bundle: server/rules.ts',
    ]);
  } finally { p.close(); }
});

test('边界检查放行合法引用：server 引入 shared、shared 引入 shared 和 zod', () => {
  const p = plugin({
    'index.server.ts': "import { a } from './shared/a.ts'; import { join } from 'node:path'; export default () => join(String(a));\n",
    'index.client.tsx': "import { a } from './shared/a.ts'; export const x = a;\n",
    'shared/a.ts': "import { z } from 'zod'; import { b } from './b.ts'; export const a = z.string().parse(b);\n",
    'shared/b.ts': "export const b = 'b';\n",
  });
  try { assert.deepEqual(checkPluginBoundaries(p.dir), []); } finally { p.close(); }
});

test('shared 里的 Claude 用量输入结构与 server/vendor 的 Paseo 副本逐字一致', () => {
  const vendored = readFileSync(join(root, 'server/vendor/paseo-0.15.0/claude-usage-source/shared/input.ts'), 'utf8');
  const shared = readFileSync(join(root, 'shared/claude-usage-input.ts'), 'utf8');
  assert.ok(shared.endsWith(vendored), 'shared/claude-usage-input.ts 必须以 vendor 副本的全文结尾');
});
