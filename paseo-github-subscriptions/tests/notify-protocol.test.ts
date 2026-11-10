import test from 'node:test';
import assert from 'node:assert/strict';
import { needsUser, questionSummary, duplicateWorkspaceIds } from '../server/notify/protocol.ts';
import { deliveryClass, questionRequest } from '../server/notify/routing.ts';
import { deliverToCurrentMain } from '../server/notify/parent.ts';
import type { Notice } from '../server/notify/engine.ts';

test('主会话待答不发送；解除时重读映射，送现任而非旧主会话；不归档', async () => {
  const n = { target: { agentId: 'old-main' }, event: 'subagent_done', id: 'stable', data: {} } as Notice;
  const sent: string[] = [];
  let current = 'successor';
  let pending = true;
  const actions = { resolve: async () => ({ agentId: current }), pending: async () => pending, send: async (id: string) => { sent.push(id); } };
  await assert.rejects(deliverToCurrentMain(n, actions), (e: any) => e.deferred === true);
  assert.deepEqual(sent, []);
  assert.equal(n.target?.agentId, 'old-main');
  current = 'newest'; pending = false;
  await deliverToCurrentMain(n, actions);
  assert.deepEqual(sent, ['newest']);
  assert.equal(n.id, 'stable');
});

test('子会话完成无现任主会话才转 Grok，其他无归属事件只记录；断连不冒充孤儿', async () => {
  const n = { target: { agentId: 'old' }, event: 'subagent_done', data: {} } as Notice;
  const actions = { resolve: async () => ({ agentId: null }), pending: async () => false, send: async () => { throw Error('不应发送'); } };
  const failed = { target: { agentId: 'old' }, event: 'error', data: { outcome: { kind: 'failed' } } } as Notice;
  assert.equal(await deliverToCurrentMain(failed, actions), 'orphan');
  assert.equal(failed.event, 'subagent_done');
  assert.equal(await deliverToCurrentMain(n, actions), 'orphan');
  assert.equal(n.target, undefined);
  assert.equal((n.data as any).orphaned, true);
  await assert.rejects(deliverToCurrentMain({ target: { agentId: 'old' }, event: 'error' } as Notice, actions), (e: any) => e.suppressed === true);
  await assert.rejects(deliverToCurrentMain({ target: { agentId: 'old' }, event: 'subagent_done' } as Notice, { ...actions, resolve: async () => { throw Error('离线'); } }), /离线/);
});

test('问题选项及推荐项完整保留，questionSummary.text 优先取首题正文而非固定标题 Question，master 与复盘必须用户确认', () => {
  const data = { title: 'Question', kind: 'question', input: { questions: [{ question: '合并master？', options: [{ label: '等待（推荐）', description: '先验收' }, { label: '继续' }] }, { question: '第二题？', options: [] }] } };
  assert.equal(needsUser(data), true);
  assert.equal(needsUser({ title: '复盘审阅' }), true);
  const q = questionSummary(data);
  assert.equal(q.text, '合并master？');
  assert.equal(q.questions.length, 2);
  assert.equal(q.options.length, 2);
  assert.equal(q.recommended.length, 1);
  assert.equal(questionSummary({ title: '回退标题', input: {} }).text, '回退标题');
});

test('重复工作区路径排除自身', () => {
  assert.deepEqual(duplicateWorkspaceIds(new Map([['a', { id: 'a', name: 'a', path: '/r' }], ['b', { id: 'b', name: 'b', path: '/r' }]]), 'b', '/r'), ['a']);
});

test('投递类别：主会话提问和错误、新项目新工作区走 Grok；子会话走主会话；其余只记录', () => {
  assert.equal(deliveryClass('asked', true, false), 'grok');
  assert.equal(deliveryClass('error', true, false), 'grok');
  assert.equal(deliveryClass('new_project', false, false), 'grok');
  for (const event of ['capacity', 'main_finalized', 'main_migration_planned', 'main_migrated', 'lb_exception']) {
    assert.equal(deliveryClass(event, false, false), 'grok');
    assert.equal(deliveryClass(event, false, true), 'grok');
  }
  assert.equal(deliveryClass('asked', false, false), 'record');
  assert.equal(deliveryClass('asked', false, true), 'parent');
  assert.equal(deliveryClass('idle', true, false), 'record');
  assert.equal(questionRequest({ kind: 'question' }), true);
  assert.equal(questionRequest({ name: 'mcp__x__AskUserQuestion' }), true);
  assert.equal(questionRequest({ name: 'Bash', kind: 'tool' }), false);
});
