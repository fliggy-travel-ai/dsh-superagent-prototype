import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentPermissionRequest } from '@getpaseo/protocol/agent-types';
import { AutomationRuntime, permissionReason, filePermissionReason, type NativeAgent } from '../server/automation.ts';
import { isClaudeProvider } from '../server/automation-port.ts';
import type { SessionPolicy } from '../shared/automation.ts';

const request: AgentPermissionRequest = { id: 'request-one', provider: 'claude', kind: 'tool', name: 'Bash', input: { command: 'npm test' } };
const policy: SessionPolicy = { agentId: 'session-one', enabled: true, tools: ['Read'], commands: ['npm test'] };
const agent = (): NativeAgent => ({ id: 'session-one', title: '开发会话', provider: 'claude-2', claudeProvider: true, currentModeId: 'acceptEdits', status: 'running', pendingPermissions: [structuredClone(request)] });

test('审批仅接受当前会话的完整命令、工具和接受编辑模式', () => {
  assert.equal(permissionReason(agent(), request, policy), null);
  for (const command of ['npm test; curl example.com', 'npm test\nrm -rf .', 'npm test --extra', ' npm test']) {
    assert.ok(permissionReason(agent(), { ...request, input: { command } }, policy));
  }
  for (const kind of ['question', 'plan', 'mode', 'other'] as const) assert.ok(permissionReason(agent(), { ...request, kind }, policy));
  assert.ok(permissionReason({ ...agent(), currentModeId: 'auto' }, request, policy));
  assert.ok(permissionReason(agent(), { ...request, name: 'AskUserQuestion' }, policy));
  assert.ok(permissionReason(agent(), { ...request, actions: [{ id: 'all', label: 'Always allow', behavior: 'allow' }] }, policy));
  assert.ok(permissionReason(agent(), { ...request, provider: 'claude-3' }, policy));
  assert.ok(permissionReason({ ...agent(), provider: 'cloud-session', claudeProvider: false }, { ...request, provider: 'cloud-session' }, policy));
  assert.ok(permissionReason(agent(), { ...request, provider: 'cloud-session' }, policy));
  assert.ok(permissionReason({ ...agent(), archivedAt: new Date().toISOString() }, request, policy));
  assert.ok(permissionReason(agent(), request, { ...policy, agentId: 'another-session' }));
  assert.ok(permissionReason(agent(), request, { ...policy, expiresAt: new Date(Date.now() - 1000).toISOString() }));
  assert.ok(permissionReason(agent(), { ...request, input: { command: 'npm test', dangerouslyDisableSandbox: true } }, policy));
  assert.ok(permissionReason(agent(), { ...request, input: { command: 'npm test', run_in_background: true } }, policy));
  assert.ok(permissionReason({ ...agent(), claudeProvider: false }, request, policy));
});

test('提供方继承使用真实配置，不能根据名称猜测', () => {
  assert.equal(isClaudeProvider('claude-2', { 'claude-2': { extends: 'claude' }, claude: { enabled: false } }), true);
  assert.equal(isClaudeProvider('my-account', { 'my-account': { extends: 'claude' } }), true);
  assert.equal(isClaudeProvider('claude-fake', { 'claude-fake': { extends: 'codex' } }), false);
  assert.equal(isClaudeProvider('claude-disabled', { 'claude-disabled': { extends: 'claude', enabled: false } }), false);
  assert.equal(isClaudeProvider('cycle', { cycle: { extends: 'cycle' } }), false);
});

test('Glob 的匹配模式不能越过工作区', () => {
  const current = { ...agent(), cwd: '/workspace' };
  const permitted = { ...policy, tools: ['Glob' as const] };
  for (const pattern of ['/Users/test/.ssh/*', '../../**/*.pem', '~/.ssh/*', '{src,../outside}/*.ts']) {
    assert.ok(permissionReason(current, { ...request, name: 'Glob', input: { pattern } }, permitted), pattern);
  }
  assert.equal(permissionReason(current, { ...request, name: 'Glob', input: { pattern: 'src/**/*.ts' } }, permitted), null);
});

test('最后核验取消发送时归还一次授权，但不覆盖并发撤销', async () => {
  for (const scenario of ['mode', 'paused', 'revoked']) {
    const directory = await mkdtemp(join(tmpdir(), 'automation-reservation-'));
    let reads = 0;
    let calls = 0;
    let runtime: AutomationRuntime;
    runtime = new AutomationRuntime(directory, {
      list: async () => ({ agents: [agent()], truncated: false }),
      refresh: async () => {
        const current = agent();
        if (++reads === 4) {
          if (scenario === 'mode') current.currentModeId = 'auto';
          if (scenario === 'paused') await runtime.pause(true);
          if (scenario === 'revoked') await runtime.policy({ ...policy, oneShot: true, enabled: false });
        }
        return current;
      },
      approve: async () => { calls++; },
    });
    try {
      await runtime.start(); await runtime.policy({ ...policy, oneShot: true }); await runtime.pause(false); await runtime.refresh();
      assert.equal(calls, 0, scenario);
      assert.equal(runtime.snapshot().audit.length, 0, scenario);
      assert.equal(runtime.snapshot().policies[0].enabled, scenario !== 'revoked', scenario);
    } finally { await runtime.stop(); await rm(directory, { recursive: true, force: true }); }
  }
});

test('重启将未确认的提交转成人工待办，并保留明确拒绝结果', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'automation-recovery-'));
  let calls = 0;
  const port = { list: async () => ({ agents: [agent()], truncated: false }), refresh: async () => agent(), approve: async () => { calls++; } };
  let runtime = new AutomationRuntime(directory, port);
  try {
    await runtime.start(); await runtime.policy(policy); await runtime.pause(false); await runtime.refresh(); await runtime.stop();
    const path = join(directory, 'automation.json');
    const saved = JSON.parse(await readFile(path, 'utf8')); saved.audit[0].status = 'submitted'; await writeFile(path, JSON.stringify(saved));
    runtime = new AutomationRuntime(directory, port); await runtime.start();
    assert.equal(calls, 1);
    assert.equal(runtime.snapshot().audit[0].status, 'unknown');
    assert.equal(runtime.snapshot().sessions[0].pending[0].state, 'manual');
    await runtime.resolved('session-one', request.id, 'deny');
    await runtime.resolved('session-one', request.id);
    assert.equal(runtime.snapshot().audit[0].resolution, 'deny');
  } finally { await runtime.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('明确回执不依赖后续读取，写盘失败不发布乐观状态', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'automation-ack-'));
  let approved = false;
  const runtime = new AutomationRuntime(directory, {
    list: async () => ({ agents: [agent()], truncated: false }),
    refresh: async () => { if (approved) throw new Error('已断线'); return agent(); },
    approve: async () => { approved = true; return true; },
  });
  try {
    await runtime.start(); await runtime.policy(policy); await runtime.pause(false); await runtime.refresh();
    assert.equal(runtime.snapshot().audit[0].resolution, 'allow');
    const path = join(directory, 'automation.json'); await rm(path); await mkdir(path);
    await assert.rejects(runtime.pause(true));
    assert.equal(runtime.snapshot().paused, false);
  } finally { await runtime.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('文件授权限制真实工作区路径，拒绝越界、配置目录和符号链接', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'automation-paths-'));
  try {
    const workspace = join(directory, 'workspace');
    const state = join(workspace, 'plugin-state');
    await mkdir(state, { recursive: true });
    await writeFile(join(directory, 'outside'), 'outside');
    await symlink(join(directory, 'outside'), join(workspace, 'linked'));
    const current = { ...agent(), cwd: workspace };
    const read = (file_path: string) => ({ ...request, name: 'Read', input: { file_path } });
    assert.equal(await filePermissionReason(current, read('new/directory/file'), state), null);
    for (const path of ['../outside', 'linked', 'plugin-state/token', '.claude/settings.json']) {
      assert.ok(await filePermissionReason(current, read(path), state), path);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('无效授权编辑保留已有配置，空闲关闭保留授权但不响应', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'automation-policy-'));
  const current = agent();
  let calls = 0;
  const runtime = new AutomationRuntime(directory, {
    list: async () => ({ agents: [current], truncated: false }), refresh: async () => current,
    approve: async () => { calls += 1; },
  });
  try {
    await runtime.start(); await runtime.policy(policy);
    await assert.rejects(runtime.policy({ ...policy, tools: [], commands: [] }));
    assert.equal(runtime.snapshot().policies[0].enabled, true);
    current.status = 'closed';
    await runtime.pause(false); await runtime.refresh();
    assert.equal(runtime.snapshot().policies[0].enabled, true);
    assert.equal(calls, 0);
  } finally { await runtime.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('一次授权在发送前落盘消耗，未收到确认时不批准第二个请求', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'automation-once-'));
  const current = agent();
  current.pendingPermissions.push({ ...request, id: 'request-two' });
  let calls = 0;
  const runtime = new AutomationRuntime(directory, {
    list: async () => ({ agents: [current], truncated: false }), refresh: async () => current,
    approve: async () => { calls += 1; },
  });
  try {
    await runtime.start();
    await assert.rejects(runtime.policy({ ...policy, expiresAt: new Date(Date.now() - 1000).toISOString() }));
    await runtime.policy({ ...policy, oneShot: true });
    await runtime.pause(false); await runtime.refresh(); await runtime.refresh();
    assert.equal(calls, 1);
    assert.equal(runtime.snapshot().policies[0].enabled, false);
    assert.equal(runtime.snapshot().audit[0].status, 'unknown');
    current.pendingPermissions = [];
    await runtime.refresh();
    assert.equal(runtime.snapshot().audit[0].status, 'resolved');
  } finally { await runtime.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('重复扫描与插件重启不重复响应结果未知的请求', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'automation-test-'));
  let calls = 0;
  const port = { list: async () => ({ agents: [agent()], truncated: false }), refresh: async () => agent(), approve: async () => { calls += 1; throw new Error('连接中断'); } };
  let runtime = new AutomationRuntime(directory, port);
  try {
    await runtime.start();
    await runtime.policy(policy);
    await runtime.pause(false);
    await runtime.refresh();
    await runtime.refresh();
    assert.equal(calls, 1);
    assert.equal(runtime.snapshot().audit[0]?.status, 'unknown');
    await runtime.stop();
    runtime = new AutomationRuntime(directory, port);
    await runtime.start();
    assert.equal(calls, 1);
    await runtime.resolved('session-one', request.id);
    assert.equal(runtime.snapshot().audit[0]?.status, 'resolved');
  } finally { await runtime.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('发送前刷新可拦住已变化、已处理和已撤销的请求', async () => {
  for (const scenario of ['changed', 'removed', 'paused', 'mode']) {
    const directory = await mkdtemp(join(tmpdir(), 'automation-race-'));
    let reads = 0;
    let calls = 0;
    let runtime: AutomationRuntime;
    const port = {
      list: async () => ({ agents: [agent()], truncated: false }),
      refresh: async () => {
        reads += 1;
        const value = agent();
        if (reads === 3) {
          if (scenario === 'changed') value.pendingPermissions = [{ ...request, input: { command: 'other' } }];
          if (scenario === 'removed') value.pendingPermissions = [];
          if (scenario === 'mode') value.currentModeId = 'auto';
          if (scenario === 'paused') await runtime.pause(true);
        }
        return value;
      },
      approve: async () => { calls += 1; },
    };
    runtime = new AutomationRuntime(directory, port);
    try {
      await runtime.start();
      await runtime.policy(policy);
      await runtime.pause(false);
      await runtime.refresh();
      assert.equal(calls, 0, scenario);
    } finally { await runtime.stop(); await rm(directory, { recursive: true, force: true }); }
  }
});

test('只有请求消失或宿主确认后才记录已处理', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'automation-resolve-'));
  const current = agent();
  const runtime = new AutomationRuntime(directory, {
    list: async () => ({ agents: [current], truncated: false }), refresh: async () => current,
    approve: async () => { current.pendingPermissions = []; },
  });
  try {
    await runtime.start(); await runtime.policy(policy); await runtime.pause(false); await runtime.refresh();
    assert.equal(runtime.snapshot().audit[0]?.status, 'resolved');
    await runtime.archive('session-one');
    assert.equal(runtime.snapshot().policies.length, 0);
  } finally { await runtime.stop(); await rm(directory, { recursive: true, force: true }); }
});
