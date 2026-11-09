import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extensionDirectory, pluginInstallDirectory } from '../server/plugin-directory.ts';

// #1737：Paseo 运行插件时不提供插件目录，import.meta.url 也不可用。扩展目录从 Paseo 配置里的插件安装路径得出。

function home(plugins: Record<string, unknown> | null) {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-dir-'));
  if (plugins) writeFileSync(join(dir, 'config.json'), JSON.stringify({ pluginsEnabled: true, plugins }));
  return { dir, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('从 Paseo 配置读出目录安装的插件路径，扩展目录存在时返回它', () => {
  const h = home(null);
  try {
    const pluginDir = join(h.dir, 'installed', 'github-subscriptions');
    mkdirSync(join(pluginDir, 'browser-extension'), { recursive: true });
    writeFileSync(join(h.dir, 'config.json'), JSON.stringify({ plugins: { 'github-subscriptions': { source: 'directory', path: pluginDir, enabled: true } } }));
    assert.equal(pluginInstallDirectory('github-subscriptions', h.dir), pluginDir);
    assert.equal(extensionDirectory('github-subscriptions', h.dir, {}), join(pluginDir, 'browser-extension'));
    assert.equal(extensionDirectory('other-plugin', h.dir, {}), null);
  } finally { h.close(); }
});

test('没有配置、不是目录安装、或目录里没有扩展时返回 null；环境变量可以指定扩展目录', () => {
  const missing = home(null);
  const npm = home({ 'github-subscriptions': { source: 'npm', path: '/somewhere', enabled: true } });
  const empty = home(null);
  try {
    assert.equal(pluginInstallDirectory('github-subscriptions', missing.dir), null);
    assert.equal(pluginInstallDirectory('github-subscriptions', npm.dir), null);
    writeFileSync(join(empty.dir, 'config.json'), JSON.stringify({ plugins: { 'github-subscriptions': { source: 'directory', path: empty.dir } } }));
    assert.equal(extensionDirectory('github-subscriptions', empty.dir, {}), null);
    assert.equal(extensionDirectory('github-subscriptions', missing.dir, { PASEO_GHSUB_EXTENSION_PATH: '/custom/extension' }), '/custom/extension');
  } finally { missing.close(); npm.close(); empty.close(); }
});
