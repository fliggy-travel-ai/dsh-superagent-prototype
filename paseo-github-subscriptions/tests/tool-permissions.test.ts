import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentPermissionRequest } from '@getpaseo/protocol/agent-types';
import { ToolPermissionRuntime, type PermissionAgent, type ToolPermissionPort } from '../server/modules/providers-tool-permissions/runtime.ts';
import { toolPermissionsModule } from '../server/modules/providers-tool-permissions/index.ts';

const request = (kind: AgentPermissionRequest['kind'] = 'tool', name = 'Bash', id = 'permission-shell'): AgentPermissionRequest => ({ id, provider: 'claude', kind, name });
const fixture = (requests = [request()]) => {
  const agent: PermissionAgent = { id: 'agent-shell', pendingPermissions: requests };
  const approved: string[] = [];
  const failed: string[] = [];
  const port: ToolPermissionPort = {
    list: async () => [agent],
    refresh: async () => agent,
    approve: async (agentId, requestId) => { approved.push(`${agentId}:${requestId}`); },
    failed: (agentId, requestId) => { failed.push(`${agentId}:${requestId}`); },
  };
  const runtime = new ToolPermissionRuntime(port);
  return { agent, port, runtime, approved, failed };
};

test('加载时批准已存在的 Bash 请求，重复扫描只批准一次', async () => {
  const state = fixture();
  await state.runtime.scan();
  await state.runtime.scan();
  assert.deepEqual(state.approved, ['agent-shell:permission-shell']);
  await state.runtime.stop();
});

test('人工提问、计划、模式和未知权限保持待处理', async () => {
  const state = fixture([
    request('question', 'AskUserQuestion'), request('plan', 'ExitPlanMode'),
    request('mode', 'change-mode'), request('other', 'unknown'),
    ...['AskUserQuestion', 'request_user_input', 'request_user_input_async', 'ExitPlanMode', 'EnterPlanMode'].map(name => request('tool', name)),
  ]);
  await state.runtime.scan();
  assert.deepEqual(state.approved, []);
});

test('批准失败后再次检查会重试，其他会话不受影响', async () => {
  const state = fixture();
  const other: PermissionAgent = { id: 'other-agent', pendingPermissions: [request()] };
  state.port.list = async () => [state.agent, other];
  state.port.refresh = async agentId => agentId === other.id ? other : state.agent;
  let attempts = 0;
  state.port.approve = async (agentId, requestId) => {
    if (agentId === state.agent.id && ++attempts === 1) throw new Error('暂时不可用');
    state.approved.push(`${agentId}:${requestId}`);
  };
  await state.runtime.scan();
  assert.deepEqual(state.failed, ['agent-shell:permission-shell']);
  assert.deepEqual(state.approved, ['other-agent:permission-shell']);
  await state.runtime.scan();
  assert.deepEqual(state.approved, ['other-agent:permission-shell', 'agent-shell:permission-shell']);
});

test('并发事件共用一次检查，不重复提交批准', async () => {
  const state = fixture();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  state.port.list = async () => { await blocked; return [state.agent]; };
  const first = state.runtime.scan();
  assert.equal(state.runtime.scan(), first);
  release();
  await first;
  assert.equal(state.approved.length, 1);
});

test('重新读取后请求已结束、已改为提问或会话已归档时不批准', async () => {
  for (const current of [null, { id: 'agent-shell', pendingPermissions: [] }, { id: 'agent-shell', pendingPermissions: [request('question')] }, { id: 'agent-shell', archivedAt: '2026-11-16', pendingPermissions: [request()] }]) {
    const state = fixture();
    state.port.refresh = async () => current;
    await state.runtime.scan();
    assert.deepEqual(state.approved, []);
  }
});

test('检查进行中停用，读取返回后不会再批准', async () => {
  const state = fixture();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  state.port.refresh = async () => { await blocked; return state.agent; };
  const checking = state.runtime.scan();
  await Promise.resolve();
  const stopping = state.runtime.stop();
  release();
  await Promise.all([checking, stopping]);
  await state.runtime.scan();
  assert.deepEqual(state.approved, []);
});

test('列表读取失败后可以恢复检查', async () => {
  const state = fixture();
  state.port.list = async () => { throw new Error('连接中断'); };
  await assert.rejects(state.runtime.scan(), /连接中断/);
  state.port.list = async () => [state.agent];
  await state.runtime.scan();
  assert.equal(state.approved.length, 1);
});

test('停用期间连接失败也能完成清理', async () => {
  const state = fixture();
  let fail!: (error: Error) => void;
  state.port.list = () => new Promise((_resolve, reject) => { fail = reject; });
  const checking = state.runtime.scan();
  const failure = assert.rejects(checking, /连接中断/);
  const stopping = state.runtime.stop();
  fail(new Error('连接中断'));
  await Promise.all([failure, stopping]);
  assert.deepEqual(state.approved, []);
});

test('模块启动、权限事件和定时补查均通过守护进程批准，卸载时清理钩子', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const state = fixture();
  const hooks = new Map<string, () => Promise<void>>();
  let resolveApproval!: () => void;
  let approval = new Promise<void>(resolve => { resolveApproval = resolve; });
  const connection = {
    client: { fetchAgents: async (options: { includeBackground: boolean }) => {
      assert.equal(options.includeBackground, true);
      return { entries: [{ agent: state.agent }], pageInfo: { hasMore: false } };
    } },
    paseo: { agents: {
      ref: () => ({ refresh: async () => ({ agent: state.agent }) }),
    } },
    approve: async (agentId: string, requestId: string) => {
      state.approved.push(`${agentId}:${requestId}`);
      resolveApproval();
    },
  };
  const dispose = toolPermissionsModule.register({
    server: { addHook(name: string, handler: () => Promise<void>) { hooks.set(name, handler); return () => hooks.delete(name); } },
    services: { daemon: { ready: async () => connection } },
  } as never);
  assert.equal(toolPermissionsModule.defaultEnabled, true);
  assert.equal(toolPermissionsModule.appliesTo({ role: 'provider' } as never), false);
  await approval;
  state.agent.pendingPermissions = [request('tool', 'Bash', 'event-request')];
  await hooks.get('agent.permission.before')!();
  assert.equal(state.approved.at(-1), 'agent-shell:event-request');
  approval = new Promise<void>(resolve => { resolveApproval = resolve; });
  state.agent.pendingPermissions = [request('tool', 'Bash', 'missed-event')];
  context.mock.timers.tick(5000);
  await approval;
  assert.equal(state.approved.at(-1), 'agent-shell:missed-event');
  assert.equal(typeof dispose, 'function');
  if (typeof dispose === 'function') await dispose();
  assert.equal(hooks.size, 0);
  state.agent.pendingPermissions = [request('tool', 'Bash', 'after-stop')];
  context.mock.timers.tick(5000);
  await Promise.resolve();
  assert.equal(state.approved.length, 3);
});
