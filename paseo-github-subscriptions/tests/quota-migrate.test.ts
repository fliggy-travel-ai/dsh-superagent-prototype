import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateLegacyClaudeQuota } from '../server/modules/usage-claude-accounts/migrate.ts';
import { readLabels, setLabel } from '../server/modules/usage-claude-accounts/labels-file.ts';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'quota-migrate-'));
  const legacy = join(root, 'claude-quota-resume');
  const target = join(root, 'new', 'quota');
  const labelsFile = join(root, 'new', 'labels.json');
  mkdirSync(join(legacy, 'renewal'), { recursive: true });
  return { root, legacy, target, labelsFile, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('复制待恢复任务、开关、历史、跨用户配置和续期目录；旧文件保持原样；标签并入 labels.json', () => {
  const { legacy, target, labelsFile, done } = setup();
  try {
    const files: Record<string, string> = {
      'jobs.json': '[{"agentId":"a","resetAt":1,"updatedAt":"x","phase":"pending"}]',
      'enabled-agents.json': '["a"]', 'disabled-agents.json': '["b"]', 'usage-history.json': '{"version":1,"entries":{}}',
      'cross-user-providers.json': '{}', 'cross-user-cache.json': '{}',
    };
    for (const [name, text] of Object.entries(files)) writeFileSync(join(legacy, name), text);
    writeFileSync(join(legacy, 'renewal', 'marker'), 'm');
    writeFileSync(join(legacy, 'account-labels.json'), JSON.stringify({ 'hidden@relay.example': '真实@example.com（Apple 登录）' }));
    const result = migrateLegacyClaudeQuota(legacy, target, labelsFile);
    for (const [name, text] of Object.entries(files)) {
      assert.equal(readFileSync(join(target, name), 'utf8'), text, name);
      assert.equal(readFileSync(join(legacy, name), 'utf8'), text, `${name} 旧文件保持原样`);
      assert.equal(statSync(join(target, name)).mode & 0o777, 0o600);
    }
    assert.equal(readFileSync(join(target, 'renewal', 'marker'), 'utf8'), 'm');
    assert.deepEqual(readLabels(labelsFile), { 'hidden@relay.example': '真实@example.com（Apple 登录）' });
    assert.equal(result.labels.added, 1);
    assert.ok(result.report.copied.includes('jobs.json'));
    assert.equal(existsSync(join(legacy, 'account-labels.json')), true);
  } finally { done(); }
});

test('可以重复运行：不覆盖新目录里已改过的文件，不覆盖已有标签', () => {
  const { legacy, target, labelsFile, done } = setup();
  try {
    writeFileSync(join(legacy, 'jobs.json'), '[1]');
    writeFileSync(join(legacy, 'account-labels.json'), JSON.stringify({ a: '旧', b: '旧B' }));
    migrateLegacyClaudeQuota(legacy, target, labelsFile);
    writeFileSync(join(target, 'jobs.json'), '[2]');
    setLabel(labelsFile, 'a', '新');
    const again = migrateLegacyClaudeQuota(legacy, target, labelsFile);
    assert.equal(readFileSync(join(target, 'jobs.json'), 'utf8'), '[2]');
    assert.deepEqual(readLabels(labelsFile), { a: '新', b: '旧B' });
    assert.deepEqual(again.report.copied, []);
    assert.equal(again.labels.added, 0);
  } finally { done(); }
});

test('旧目录不存在时什么都不做；旧标签文件损坏时不影响其他文件', () => {
  const { root, legacy, target, labelsFile, done } = setup();
  try {
    assert.deepEqual(migrateLegacyClaudeQuota(join(root, 'none'), target, labelsFile).report.copied, []);
    writeFileSync(join(legacy, 'jobs.json'), '[]');
    writeFileSync(join(legacy, 'account-labels.json'), '{坏');
    const result = migrateLegacyClaudeQuota(legacy, target, labelsFile);
    assert.deepEqual(result.report.copied, ['jobs.json']);
    assert.equal(result.labels.added, 0);
    assert.equal(existsSync(labelsFile), false);
  } finally { done(); }
});

test('标签文件：写入、删除、权限 0600、非字符串值忽略', () => {
  const { root, done } = setup();
  try {
    const file = join(root, 'labels.json');
    setLabel(file, 'k', 'v');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    writeFileSync(file, JSON.stringify({ k: 'v', bad: 1 }));
    assert.deepEqual(readLabels(file), { k: 'v' });
    setLabel(file, 'k', null);
    assert.deepEqual(readLabels(file), {});
  } finally { done(); }
});
