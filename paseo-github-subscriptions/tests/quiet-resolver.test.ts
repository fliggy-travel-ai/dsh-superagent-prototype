import test from 'node:test';
import assert from 'node:assert/strict';
import { createMainResolver } from '../server/modules/answer-quiet-children/resolver.ts';
import { parseWorkspaceRoles, type RoleAgent } from '../server/core/session-roles.ts';

const roles = parseWorkspaceRoles([{ workspaceId: 'wks_main', pinnedAt: 'x' }]);
const agent = (id: string, extra: Partial<RoleAgent> = {}): RoleAgent => ({ id, workspaceId: 'wks_main', status: 'idle', updatedAt: '2026-11-08T00:00:00Z', ...extra });

test('父会话仍是主会话时用父会话，并返回它的工作区', async () => {
  const resolve = createMainResolver({ list: async () => [agent('p'), agent('c', { workspaceId: 'wks_sub' })], roles: { read: async () => roles } });
  assert.deepEqual(await resolve({ parentId: 'p' }), { agentId: 'p', workspaceId: 'wks_main' });
});

test('接班：父会话已归档时发给同工作区最近活动的主会话', async () => {
  const resolve = createMainResolver({ list: async () => [agent('p', { archivedAt: 'x' }), agent('a', { updatedAt: '2026-11-08T01:00:00Z' }), agent('b', { updatedAt: '2026-11-08T02:00:00Z' })], roles: { read: async () => roles } });
  assert.deepEqual(await resolve({ parentId: 'p', childId: 'c' }), { agentId: 'b', workspaceId: 'wks_main' });
});

test('父会话已消失时用调用方给的工作区；没有线索则不猜', async () => {
  const resolve = createMainResolver({ list: async () => [agent('a')], roles: { read: async () => roles } });
  assert.deepEqual(await resolve({ parentId: 'gone', parentWorkspaceId: 'wks_main' }), { agentId: 'a', workspaceId: 'wks_main' });
  assert.deepEqual(await resolve({ parentId: 'gone' }), { agentId: null, workspaceId: null });
});

test('读取置顶状态失败时抛错，由引擎重试，不当作没有主会话', async () => {
  const resolve = createMainResolver({ list: async () => [agent('p')], roles: { read: async () => { throw new Error('读取失败'); } } });
  await assert.rejects(resolve({ parentId: 'p' }), /读取失败/);
});
