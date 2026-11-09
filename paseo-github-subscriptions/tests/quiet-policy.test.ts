import test from 'node:test';
import assert from 'node:assert/strict';
import { attentionClearScope, shouldClearAttention } from '../server/modules/answer-quiet-children/policy.ts';
import { AttentionClearer } from '../server/modules/answer-quiet-children/clearer.ts';
import { parseWorkspaceRoles } from '../server/core/session-roles.ts';

const roles = parseWorkspaceRoles([
  { workspaceId: 'wks_main', pinnedAt: '2026-11-03T00:00:00Z' },
  { workspaceId: 'wks_sub', pinnedAt: null },
  { workspaceId: 'wks_old', archivedAt: '2026-11-03T00:00:00Z' },
]);

test('子会话的待查看清除，主会话保留', () => {
  assert.equal(shouldClearAttention({ workspaceId: 'wks_sub', status: 'idle', requiresAttention: true, attentionReason: 'finished' }, roles), true);
  assert.equal(shouldClearAttention({ workspaceId: 'wks_main', status: 'idle', requiresAttention: true }, roles), false);
  assert.equal(shouldClearAttention({ workspaceId: 'wks_sub', requiresAttention: false }, roles), false);
  assert.equal(shouldClearAttention({ workspaceId: null, requiresAttention: true }, roles), false);
  assert.equal(shouldClearAttention({ workspaceId: 'wks_old', status: 'idle', requiresAttention: true }, roles), false);
});

test('子会话等待工具授权时保留提醒；等待提问时，只有提问会转给主会话才清除', () => {
  assert.equal(shouldClearAttention({ workspaceId: 'wks_sub', status: 'idle', requiresAttention: true, pendingPermissions: [{ kind: 'tool' }] }, roles, { questionHandled: true }), false);
  const question = { workspaceId: 'wks_sub', status: 'running', requiresAttention: true, pendingPermissions: [{ kind: 'question' }] };
  assert.equal(shouldClearAttention(question, roles), false);
  assert.equal(shouldClearAttention(question, roles, { questionHandled: false }), false);
  assert.equal(shouldClearAttention(question, roles, { questionHandled: true }), true);
  assert.equal(attentionClearScope(question, roles, { questionHandled: true }), 'agent');
  assert.equal(attentionClearScope(question, roles), null);
});

test('已关闭、初始化中和状态未知的会话不处理', () => {
  for (const status of ['closed', 'initializing', undefined]) {
    assert.equal(shouldClearAttention({ workspaceId: 'wks_sub', status, requiresAttention: true }, roles), false);
  }
});

test('清除范围：提问和授权按会话，其余按工作区', () => {
  assert.equal(attentionClearScope({ workspaceId: 'wks_sub', status: 'idle', requiresAttention: true, attentionReason: 'finished' }, roles), 'workspace');
  assert.equal(attentionClearScope({ workspaceId: 'wks_sub', status: 'idle', requiresAttention: true, attentionReason: 'permission' }, roles), 'agent');
  assert.equal(attentionClearScope({ workspaceId: 'wks_sub', status: 'idle', requiresAttention: true, pendingPermissions: [{ kind: 'question' }] }, roles, { questionHandled: true }), 'agent');
  assert.equal(attentionClearScope({ workspaceId: 'wks_main', status: 'idle', requiresAttention: true }, roles), null);
});

test('清除队列：会话逐个、工作区每批 20 个；单批失败不影响后面', async () => {
  const calls: Array<[string, string[]]> = [];
  const logs: string[] = [];
  let failNext = true;
  const clearer = new AttentionClearer({
    clearAgents: async ids => { calls.push(['agent', ids]); },
    clearWorkspaces: async ids => { calls.push(['workspace', ids]); if (failNext) { failNext = false; throw new Error('断开'); } },
    log: line => logs.push(line),
    signal: new AbortController().signal,
  });
  for (let index = 0; index < 25; index++) clearer.enqueue('workspace', `agent-${index}`, `wks-${index}`);
  clearer.enqueue('agent', 'a1', 'wks-x');
  clearer.enqueue('agent', 'a1', 'wks-x');
  await clearer.idle();
  assert.deepEqual(calls.map(([kind, ids]) => [kind, ids.length]), [['workspace', 20], ['workspace', 5], ['agent', 1]]);
  assert.ok(logs.some(line => line.includes('清除待查看失败')));
});

test('停止信号取消尚未发送的清除', async () => {
  const controller = new AbortController();
  const calls: string[][] = [];
  const clearer = new AttentionClearer({ clearAgents: async ids => { calls.push(ids); }, clearWorkspaces: async () => {}, log: () => {}, signal: controller.signal });
  controller.abort();
  clearer.enqueue('agent', 'a', 'w');
  await clearer.idle();
  assert.deepEqual(calls, []);
});
