import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeployArgs, roleFileContent, readRoleFile, providersHostedBy, runningTurns, pluginIdFor } from '../scripts/deploy-lib.ts';

test('参数：角色和提交必填，目录按角色默认', () => {
  assert.deepEqual(parseDeployArgs(['--role', 'provider', '--ref', 'v1.2.0'], '/Users/me'), {
    role: 'provider', ref: 'v1.2.0', target: '/Users/me/.paseo/local-plugins/dev-automation-providers', reload: false, install: false, dryRun: false, host: null, paseo: 'paseo',
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
