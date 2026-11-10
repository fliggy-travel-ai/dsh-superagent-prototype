import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeployArgs, assertRoleChange, roleFileContent, readRoleFile, providersHostedBy, runningTurns, pluginIdFor } from '../scripts/deploy-lib.ts';

test('参数：角色和提交必填，目录按角色默认', () => {
  assert.deepEqual(parseDeployArgs(['--role', 'provider', '--ref', 'v1.2.0'], '/Users/me'), {
    role: 'provider', changeRole: false, ref: 'v1.2.0', target: '/Users/me/.paseo/local-plugins/dev-automation-providers', reload: false, install: false, dryRun: false, host: null, paseo: 'paseo',
  });
  const parsed = parseDeployArgs(['--role', 'main', '--ref', 'abc123', '--target', '/tmp/x', '--reload', '--host', 'h:1', '--paseo', '/bin/paseo', '--dry-run'], '/Users/me');
  assert.equal(parsed.target, '/tmp/x'); assert.equal(parsed.reload, true); assert.equal(parsed.host, 'h:1'); assert.equal(parsed.dryRun, true); assert.equal(parsed.paseo, '/bin/paseo');
  assert.equal(parseDeployArgs(['--role', 'main', '--ref', 'x'], '/Users/me').target, '/Users/me/.paseo/local-plugins/github-subscriptions');
  assert.throws(() => parseDeployArgs(['--ref', 'x'], '/h'), /--role/);
  assert.throws(() => parseDeployArgs(['--role', 'other', '--ref', 'x'], '/h'), /--role/);
  assert.throws(() => parseDeployArgs(['--role', 'main'], '/h'), /--ref/);
  assert.throws(() => parseDeployArgs(['--role', 'main', '--ref', 'x', '--bogus'], '/h'), /未知参数/);
});

test('角色文件可以写入和读回，读不到时按兼容模式', () => {
  for (const role of ['main', 'provider'] as const) assert.equal(readRoleFile(roleFileContent(role)), role);
  assert.match(roleFileContent('provider'), /export const INSTANCE_ROLE: 'main' \| 'provider' \| null = 'provider';/);
  assert.equal(readRoleFile("export const INSTANCE_ROLE: 'main' | 'provider' | null = null;"), null);
  assert.equal(readRoleFile(null), null);
  assert.throws(() => readRoleFile('invalid'), /无法识别/);
});

test('各角色托管的 Provider：兼容模式托管云端会话，main 不托管', () => {
  assert.deepEqual(providersHostedBy(null), ['cloud-session', 'antigravity-*']);
  assert.deepEqual(providersHostedBy('main'), []);
  assert.deepEqual(providersHostedBy('provider'), ['cloud-session', 'antigravity-*']);
  assert.equal(pluginIdFor('main'), 'github-subscriptions');
  assert.equal(pluginIdFor('provider'), 'dev-automation-providers');
});

test('只统计这些 Provider 的运行中会话', () => {
  const agents = [
    { id: '1', name: 'a', provider: 'cloud-session/default', status: 'running' },
    { id: '2', name: 'b', provider: 'cloud-session', status: 'idle' },
    { id: '3', name: 'c', provider: 'antigravity-cy517/gemini', status: 'running' },
    { id: '4', name: 'd', provider: 'claude/opus', status: 'running' },
  ];
  assert.deepEqual(runningTurns(agents, ['cloud-session', 'antigravity-*']).map(agent => agent.id), ['1', '3']);
  assert.deepEqual(runningTurns(agents, []), []);
});

test('兼容模式与角色变更保护', () => {
  const opts = parseDeployArgs(['--role', 'compat', '--ref', 'x'], '/Users/me');
  assert.equal(opts.target, '/Users/me/.paseo/local-plugins/github-subscriptions');
  assert.equal(readRoleFile(roleFileContent('compat')), null);
  assert.deepEqual(providersHostedBy('compat'), providersHostedBy(null));
  assert.throws(() => assertRoleChange(null, 'main', false), /--change-role/);
  assert.throws(() => assertRoleChange('provider', 'compat', false), /--change-role/);
  assert.doesNotThrow(() => assertRoleChange(null, 'compat', false));
  assert.doesNotThrow(() => assertRoleChange(null, 'main', true));
  assert.equal(parseDeployArgs(['--role', 'main', '--ref', 'x', '--change-role'], '/h').changeRole, true);
});

test('部署命令在准备文件前阻止意外切换兼容角色', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const target = await mkdtemp(join(tmpdir(), 'deployment-role-'));
  try {
    await mkdir(join(target, 'shared')); await writeFile(join(target, 'shared', 'instance.ts'), roleFileContent('compat'));
    const call = (role: string, change = false) => spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/deploy.ts', '--role', role, '--ref', 'HEAD', '--target', target, '--dry-run', ...(change ? ['--change-role'] : [])], { cwd: process.cwd(), encoding: 'utf8' });
    const blocked = call('main'); assert.equal(blocked.status, 1); assert.match(blocked.stderr, /--change-role/);
    assert.equal(call('compat').status, 0); assert.equal(call('main', true).status, 0);
  } finally { await rm(target, { recursive: true, force: true }); }
});
