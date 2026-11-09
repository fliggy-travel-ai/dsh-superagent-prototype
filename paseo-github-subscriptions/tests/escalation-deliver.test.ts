import test from 'node:test';
import assert from 'node:assert/strict';
import { createSender, noticeRecord } from '../server/modules/answer-escalation/deliver.ts';
import type { Notice } from '../server/notify/engine.ts';
import type { EscalationRecord } from '../server/modules/answer-escalation/records.ts';

const notice = (extra: Partial<Notice> = {}): Notice => ({
  id: 'n1', key: 'k1', event: 'asked', agentId: 'main', hostId: 'macmini', machine: 'macmini', workspaceId: 'wks', title: '订单开发', provider: 'claude',
  permissionId: 'p', firstSeenAt: '2026-11-08T10:00:00.000Z', answeredBy: null, provenance: 'not_applicable',
  questionSummary: { text: '是否合并？', questions: [], options: [], recommended: [] }, needsUser: false, wake: 'immediate', coalesceWindowSeconds: 60,
  at: Date.parse('2026-11-08T10:00:00.000Z'), data: {}, ...extra,
});
function fixture(mode: 'shadow' | 'live' = 'shadow') {
  const state = { mode, mains: new Set(['main']), suppress: false, postError: null as unknown, posts: [] as Notice[], audits: [] as Record<string, unknown>[], records: [] as EscalationRecord[] };
  const send = createSender({
    mode: () => state.mode,
    audit: async entry => { state.audits.push(entry); },
    isMain: id => state.mains.has(id),
    prefilter: async () => state.suppress,
    credentials: async () => ({ url: 'http://127.0.0.1:1/hook', auth: 'X-Test: test-secret' }),
    post: async item => { if (state.postError) throw state.postError; state.posts.push(item); return { httpStatus: 202 }; },
    records: { upsert: record => { state.records.push(record); } },
    now: () => Date.parse('2026-11-08T10:01:00.000Z'),
  });
  return { state, send };
}

test('影子模式只记录，不读凭据、不发送', async () => {
  const { state, send } = fixture('shadow');
  await send(notice());
  assert.deepEqual(state.posts, []);
  assert.deepEqual(state.audits.map(a => a.phase), ['delivery-attempt', 'recorded-shadow']);
  assert.equal(state.records[0]!.status, 'recorded-shadow');
  assert.equal(state.records[0]!.delivery, 'shadow');
});

test('实际发送：送到 webhook，审计记录状态码，页面记录为已送达', async () => {
  const { state, send } = fixture('live');
  await send(notice());
  assert.equal(state.posts.length, 1);
  const delivered = state.audits.find(a => a.phase === 'delivered')!;
  assert.equal(delivered.httpStatus, 202);
  assert.equal(delivered.channel, 'grok-webhook');
  assert.equal(state.records[0]!.status, 'delivered');
  assert.equal(state.records[0]!.questionText, '是否合并？');
});

test('发送失败：页面记录为失败并继续抛出，让引擎重试；重试成功后更新同一条记录', async () => {
  const { state, send } = fixture('live');
  state.postError = Object.assign(new Error('Webhook HTTP 502'), { httpStatus: 502 });
  await assert.rejects(send(notice()), /502/);
  assert.equal(state.records.at(-1)!.status, 'failed');
  state.postError = null;
  await send(notice());
  assert.deepEqual(state.records.map(r => [r.id, r.status]), [['n1', 'failed'], ['n1', 'delivered']]);
});

test('已不是主会话的事件（置顶被取消）只记录，不发送', async () => {
  const { state, send } = fixture('live');
  state.mains.clear();
  await assert.rejects(send(notice()), (e: any) => e.suppressed === true);
  assert.deepEqual(state.posts, []);
});

test('新建项目和工作区没有会话，也能发送', async () => {
  const { state, send } = fixture('live');
  await send(notice({ event: 'new_project', agentId: '', title: '新项目' }));
  assert.equal(state.posts.length, 1);
});

test('子会话完结通知只记录；预筛要求过滤时不发送并记审计', async () => {
  const { state, send } = fixture('live');
  await assert.rejects(send(notice({ event: 'subagent_done' })), (e: any) => e.suppressed === true);
  state.suppress = true;
  await send(notice({ id: 'n2' }));
  assert.deepEqual(state.posts, []);
  assert.ok(state.audits.some(a => a.phase === 'prefilter-suppressed'));
});

test('页面记录：提问显示问题文字，其他事件显示事件名和标题', () => {
  const now = () => Date.parse('2026-11-08T10:01:00.000Z');
  assert.equal(noticeRecord(notice(), 'live', 'delivered', now).summary, '提问：是否合并？');
  const project = noticeRecord(notice({ event: 'new_project', agentId: '', title: '新项目', questionSummary: { text: '', questions: [], options: [], recommended: [] } }), 'shadow', 'recorded-shadow', now);
  assert.equal(project.summary, '新项目：新项目');
  assert.equal(project.agentId, '');
});

test('页面记录带来源请求编号：单条取自身请求，合并通知取全部提问成员并去重', () => {
  assert.deepEqual(noticeRecord(notice({ requestId: 'p' }), 'live', 'delivered').requests, [{ agentId: 'main', requestId: 'p' }]);
  const group = notice({ requestId: 'p1', events: [notice({ id: 'a', requestId: 'p1' }), notice({ id: 'b', agentId: 'x', requestId: 'p2' }), notice({ id: 'c', event: 'new_project', agentId: '', requestId: undefined, permissionId: null })] });
  assert.deepEqual(noticeRecord(group, 'live', 'delivered').requests, [{ agentId: 'main', requestId: 'p1' }, { agentId: 'x', requestId: 'p2' }]);
  assert.equal(noticeRecord(notice({ event: 'error', requestId: undefined, permissionId: null }), 'live', 'delivered').requests, undefined);
});
