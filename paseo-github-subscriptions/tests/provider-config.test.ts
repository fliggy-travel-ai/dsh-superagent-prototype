import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupConfigFile, verifyProviderEntry, writeProviderEntry } from '../server/core/provider-config.ts';

function setup(config: unknown = { version: 1, agents: { providers: { claude: { label: 'Claude' }, 'claude-2': { extends: 'claude', label: 'old', env: { A: '1' } } } }, other: true }) {
  const home = mkdtempSync(join(tmpdir(), 'config-writer-'));
  writeFileSync(join(home, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return { home, done: () => rmSync(home, { recursive: true, force: true }) };
}

test('备份名精确到毫秒，同一毫秒多次备份不覆盖，内容与原文件一致，权限 0600', () => {
  const { home, done } = setup();
  try {
    const now = () => Date.parse('2026-11-08T12:00:00.123Z');
    const first = backupConfigFile(home, now);
    const second = backupConfigFile(home, now);
    assert.notEqual(first, second);
    assert.match(first, /config\.json\.bak-20261108T120000123$/);
    assert.equal(readFileSync(first, 'utf8'), readFileSync(join(home, 'config.json'), 'utf8'));
    assert.equal(statSync(first).mode & 0o777, 0o600);
    writeFileSync(join(home, 'config.json'), '{"changed":true}');
    assert.notEqual(readFileSync(first, 'utf8'), '{"changed":true}');
  } finally { done(); }
});

test('写 Provider：合并到 agents.providers，其他配置不动，原子写入，权限 0600，写后读回一致', () => {
  const { home, done } = setup();
  try {
    writeProviderEntry(home, 'claude-3', { extends: 'claude', label: 'Claude 3（待登录）', env: { CLAUDE_CONFIG_DIR: '/u/.claude-3' }, enabled: true });
    writeProviderEntry(home, 'claude-2', { label: '新名称' });
    const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    assert.equal(config.other, true);
    assert.deepEqual(config.agents.providers['claude-3'].env, { CLAUDE_CONFIG_DIR: '/u/.claude-3' });
    assert.deepEqual(config.agents.providers['claude-2'], { extends: 'claude', label: '新名称', env: { A: '1' } });
    assert.equal(statSync(join(home, 'config.json')).mode & 0o777, 0o600);
    assert.equal(existsSync(join(home, 'config.json.tmp')), false);
  } finally { done(); }
});

test('读不到或损坏的 config.json 不写，不创建新文件', () => {
  const { home, done } = setup('{坏');
  try {
    assert.throws(() => writeProviderEntry(home, 'claude-3', { label: 'x' }), /config\.json/);
    assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), '{坏');
  } finally { done(); }
});

test('读回核对：extends 和配置目录不一致时报错并提示备份', () => {
  const { home, done } = setup({ agents: { providers: { 'claude-3': { label: 'x' } } } });
  try {
    assert.throws(() => verifyProviderEntry(home, 'claude-3', { extends: 'claude', env: { CLAUDE_CONFIG_DIR: '/u/.claude-3' } }, '/backup/path'), /读回不一致.*extends.*\/backup\/path/);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ agents: { providers: { 'claude-3': { extends: 'claude', env: { CLAUDE_CONFIG_DIR: '/other' } } } } }));
    assert.throws(() => verifyProviderEntry(home, 'claude-3', { extends: 'claude', env: { CLAUDE_CONFIG_DIR: '/u/.claude-3' } }, '/b'), /env/);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ agents: { providers: { 'claude-3': { extends: 'claude', env: { CLAUDE_CONFIG_DIR: '/u/.claude-3', X: '1' }, label: 'l' } } } }));
    verifyProviderEntry(home, 'claude-3', { extends: 'claude', env: { CLAUDE_CONFIG_DIR: '/u/.claude-3', X: '1' }, label: 'l' }, '/b');
  } finally { done(); }
});

import { backupFile, readJsonStrict, restoreFromBackup, writeJsonFile } from '../server/core/provider-config.ts';

test('严格读取：不存在返回 null；存在但无法解析时抛错，不当作空对象', () => {
  const { home, done } = setup();
  try {
    assert.equal(readJsonStrict(join(home, 'missing.json')), null);
    assert.deepEqual(readJsonStrict(join(home, 'config.json')), JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')));
    writeFileSync(join(home, 'broken.json'), '{坏');
    assert.throws(() => readJsonStrict(join(home, 'broken.json')), /broken\.json 无法解析/);
    mkdirSync(join(home, 'dir.json'));
    assert.throws(() => readJsonStrict(join(home, 'dir.json')), /无法读取/);
  } finally { done(); }
});

test('通用备份、原子写入（0600）和从备份恢复', () => {
  const { home, done } = setup();
  try {
    const path = join(home, 'machine.json');
    writeJsonFile(path, { version: 1 });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const backup = backupFile(path, () => 1);
    assert.match(backup, /machine\.json\.bak-/);
    writeJsonFile(path, { version: 2 });
    restoreFromBackup(backup, path);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 1 });
    assert.equal(existsSync(`${path}.tmp`), false);
  } finally { done(); }
});
