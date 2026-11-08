import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRolesReader, isChildSession, isMainSession, parentLink, parseWorkspaceRoles, resolveForwardTarget, type RoleAgent } from '../server/core/session-roles.ts';

const roles = parseWorkspaceRoles([
  { workspaceId: 'wks_main', pinnedAt: '2026-11-03T00:00:00Z' },
  { workspaceId: 'wks_sub', pinnedAt: null },
  { workspaceId: 'wks_old', pinnedAt: '2026-11-01T00:00:00Z', archivedAt: '2026-11-02T00:00:00Z' },
  { workspaceId: 'wks_gone', archivedAt: '2026-11-02T00:00:00Z' },
  { workspaceId: 1, pinnedAt: 'x' },
]);
const agent = (id: string, extra: Partial<RoleAgent> = {}): RoleAgent => ({ id, workspaceId: 'wks_main', status: 'idle', updatedAt: '2026-11-08T00:00:00Z', ...extra });

test('只取置顶且未归档的工作区为主会话工作区', () => {
  assert.deepEqual([...roles.pinned], ['wks_main']);
  assert.deepEqual([...roles.archived].sort(), ['wks_gone', 'wks_old']);
  assert.equal(parseWorkspaceRoles(null).pinned.size, 0);
});

test('置顶工作区中的会话是主会话，与父会话标签无关', () => {
  assert.equal(isMainSession(agent('a'), roles), true);
  assert.equal(isMainSession(agent('a', { labels: { 'paseo.parent-agent-id': 'x' } }), roles), true);
  assert.equal(isMainSession(agent('a', { workspaceId: 'wks_sub' }), roles), false);
  assert.equal(isMainSession(agent('a', { workspaceId: null }), roles), false);
  assert.equal(isMainSession(agent('a', { workspaceId: 'wks_old' }), roles), false);
});

test('子会话：有工作区、未置顶、未归档；未知工作区不算子会话', () => {
  assert.equal(isChildSession(agent('a', { workspaceId: 'wks_sub' }), roles), true);
  assert.equal(isChildSession(agent('a'), roles), false);
  assert.equal(isChildSession(agent('a', { workspaceId: 'wks_old' }), roles), false);
  assert.equal(isChildSession(agent('a', { workspaceId: null }), roles), false);
  assert.equal(isChildSession(agent('a', { workspaceId: 'wks_unknown' }), roles), true);
});

test('父会话标签只用来找转发目标', () => {
  assert.deepEqual(parentLink({ labels: { 'paseo.parent-agent-id': 'p', 'paseo.parent-server-id': 'srv' } }), { agentId: 'p', serverId: 'srv' });
  assert.deepEqual(parentLink({ labels: { 'paseo.parent-agent-id': 'p' } }), { agentId: 'p' });
  assert.equal(parentLink({ labels: {} }), null);
  assert.equal(parentLink({}), null);
});

test('转发目标：父会话仍是主会话时直接用父会话', () => {
  const parent = agent('p');
  assert.deepEqual(resolveForwardTarget({ parentId: 'p', childId: 'c', agents: [parent, agent('c', { workspaceId: 'wks_sub' })], roles }), { agentId: 'p', reason: 'parent' });
});

test('转发目标：父会话已归档或不在置顶工作区时，改发同工作区最近活动的主会话', () => {
  const agents = [
    agent('p', { archivedAt: '2026-11-08T01:00:00Z' }),
    agent('a', { updatedAt: '2026-11-08T02:00:00Z' }),
    agent('b', { updatedAt: '2026-11-08T03:00:00Z' }),
    agent('closed', { status: 'closed', updatedAt: '2026-11-08T09:00:00Z' }),
    agent('other', { workspaceId: 'wks_sub', updatedAt: '2026-11-08T09:00:00Z' }),
    agent('c', { workspaceId: 'wks_sub' }),
  ];
  assert.deepEqual(resolveForwardTarget({ parentId: 'p', childId: 'c', agents, roles }), { agentId: 'b', reason: 'successor' });
});

test('转发目标：父会话已消失时用记录的工作区；找不到或工作区未置顶时不发送', () => {
  const agents = [agent('a'), agent('c', { workspaceId: 'wks_sub' })];
  assert.deepEqual(resolveForwardTarget({ parentId: 'gone', parentWorkspaceId: 'wks_main', childId: 'c', agents, roles }), { agentId: 'a', reason: 'successor' });
  assert.equal(resolveForwardTarget({ parentId: 'gone', childId: 'c', agents, roles }), null);
  assert.equal(resolveForwardTarget({ parentId: 'gone', parentWorkspaceId: 'wks_sub', childId: 'c', agents, roles }), null);
  assert.equal(resolveForwardTarget({ parentId: 'gone', parentWorkspaceId: 'wks_main', childId: 'c', agents: [agent('c', { workspaceId: 'wks_sub' })], roles }), null);
});

test('转发目标：不把子会话自己当作接班会话', () => {
  const agents = [agent('c')];
  assert.equal(resolveForwardTarget({ parentId: 'gone', parentWorkspaceId: 'wks_main', childId: 'c', agents, roles }), null);
});

test('读取器按修改时间缓存；没有文件算没有置顶；损坏时抛错而不是当作没有置顶', async () => {
  const home = mkdtempSync(join(tmpdir(), 'roles-'));
  try {
    const reader = createRolesReader(home);
    assert.equal((await reader.read()).pinned.size, 0);
    mkdirSync(join(home, 'projects'));
    const file = join(home, 'projects', 'workspaces.json');
    writeFileSync(file, JSON.stringify([{ workspaceId: 'w1', pinnedAt: 'x' }]));
    assert.deepEqual([...(await reader.read()).pinned], ['w1']);
    writeFileSync(file, '{坏');
    await assert.rejects(reader.read());
  } finally { rmSync(home, { recursive: true, force: true }); }
});
