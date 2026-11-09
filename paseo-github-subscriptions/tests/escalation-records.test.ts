import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EscalationRecords, type EscalationRecord } from '../server/modules/answer-escalation/records.ts';

const record = (id: string, extra: Partial<EscalationRecord> = {}): EscalationRecord => ({
  id, event: 'asked', agentId: 'main', sessionTitle: '订单开发', workspaceId: 'wks', questionText: '是否合并？', summary: '提问：是否合并？',
  at: '2026-11-08T10:00:00.000Z', delivery: 'shadow', status: 'recorded-shadow', acknowledged: false, ...extra,
});

test('同一事件重试后按编号更新状态；失败的不算待办，送达后才算', () => {
  const dir = mkdtempSync(join(tmpdir(), 'records-'));
  try {
    const store = new EscalationRecords(join(dir, 'records.json'), () => Date.parse('2026-11-08T12:00:00Z'));
    store.upsert(record('a', { status: 'failed' }));
    assert.deepEqual(store.pending(), []);
    store.upsert(record('a', { status: 'delivered', delivery: 'live' }));
    assert.deepEqual(store.pending().map(item => [item.id, item.status]), [['a', 'delivered']]);
    assert.equal(store.recent().length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('标为已处理后移出待办，仍留在最近记录；重启后保持，文件权限 0600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'records-'));
  try {
    const path = join(dir, 'records.json');
    const now = () => Date.parse('2026-11-08T12:00:00Z');
    const store = new EscalationRecords(path, now);
    store.upsert(record('a'));
    store.upsert(record('b', { at: '2026-11-08T11:00:00.000Z' }));
    assert.equal(store.acknowledge('a'), true);
    assert.equal(store.acknowledge('missing'), false);
    const reopened = new EscalationRecords(path, now);
    assert.deepEqual(reopened.pending().map(item => item.id), ['b']);
    assert.deepEqual(reopened.recent().map(item => item.id), ['b', 'a']);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('七天前的待办不再显示；总数有上限；只有提问和错误进待办', () => {
  const dir = mkdtempSync(join(tmpdir(), 'records-'));
  try {
    const store = new EscalationRecords(join(dir, 'records.json'), () => Date.parse('2026-11-08T12:00:00Z'), 3);
    store.upsert(record('old', { at: '2026-11-01T11:00:00.000Z' }));
    store.upsert(record('project', { event: 'new_project' }));
    assert.deepEqual(store.pending(), []);
    for (const id of ['1', '2', '3', '4']) store.upsert(record(id));
    assert.deepEqual(store.recent(10).map(item => item.id).sort(), ['2', '3', '4']);
    store.upsert(record('err', { event: 'error' }));
    assert.ok(store.pending().some(item => item.id === 'err'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('文件损坏时从空记录开始，不让模块启动失败', () => {
  const dir = mkdtempSync(join(tmpdir(), 'records-'));
  try {
    const path = join(dir, 'records.json');
    const store = new EscalationRecords(path, Date.now);
    store.upsert(record('a'));
    writeFileSync(path, '坏');
    assert.deepEqual(new EscalationRecords(path, Date.now).recent(), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('来源提问不再等待时自动结束：多个请求全部结束才移出待办，结束原因和时间写入记录，重启后保持', () => {
  const dir = mkdtempSync(join(tmpdir(), 'records-'));
  try {
    const path = join(dir, 'records.json');
    const now = () => Date.parse('2026-11-08T12:00:00Z');
    const store = new EscalationRecords(path, now);
    store.upsert(record('group', { requests: [{ agentId: 'main', requestId: 'p1' }, { agentId: 'main', requestId: 'p2' }] }));
    store.upsert(record('other', { requests: [{ agentId: 'main', requestId: 'p3' }] }));
    assert.deepEqual(store.closeRequest('main', 'p1', 'resolved').map(item => item.id), []);
    assert.deepEqual(store.pending().map(item => item.id).sort(), ['group', 'other']);
    assert.deepEqual(store.closeRequest('main', 'p2', 'resolved').map(item => item.id), ['group']);
    assert.deepEqual(store.pending().map(item => item.id), ['other']);
    const reopened = new EscalationRecords(path, now);
    const closed = reopened.recent().find(item => item.id === 'group')!;
    assert.equal(closed.closedReason, 'resolved');
    assert.equal(closed.closedAt, '2026-11-08T12:00:00.000Z');
    assert.deepEqual(reopened.closures().map(item => item.id), ['group']);
    // 已结束的再收到同一请求不重复结束；人工点“标为已处理”仍返回成功。
    assert.deepEqual(reopened.closeRequest('main', 'p2', 'resolved'), []);
    assert.equal(reopened.acknowledge('group'), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('按会话现状对账：会话不存在、已归档、已关闭时全部结束；提问不在等待列表时结束；仍在等待的保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'records-'));
  try {
    const store = new EscalationRecords(join(dir, 'records.json'), () => Date.parse('2026-11-08T12:00:00Z'));
    store.upsert(record('waiting', { agentId: 'a', requests: [{ agentId: 'a', requestId: 'p1' }] }));
    store.upsert(record('answered', { agentId: 'a', requests: [{ agentId: 'a', requestId: 'p0' }] }));
    store.upsert(record('legacy', { agentId: 'b' }));
    store.upsert(record('legacy-waiting', { agentId: 'c' }));
    store.upsert(record('gone', { agentId: 'd', requests: [{ agentId: 'd', requestId: 'p9' }] }));
    store.upsert(record('archived', { agentId: 'e', requests: [{ agentId: 'e', requestId: 'p8' }] }));
    store.upsert(record('error-open', { agentId: 'f', event: 'error' }));
    store.upsert(record('error-resumed', { agentId: 'g', event: 'error' }));
    assert.deepEqual(store.agentsWithOpen().sort(), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    const closed = [
      ...store.settleAgent('a', { status: 'running', archivedAt: null, pending: ['p1'] }),
      ...store.settleAgent('b', { status: 'idle', archivedAt: null, pending: [] }),
      ...store.settleAgent('c', { status: 'running', archivedAt: null, pending: ['p5'] }),
      ...store.settleAgent('d', null),
      ...store.settleAgent('e', { status: 'idle', archivedAt: '2026-11-08T11:00:00.000Z', pending: ['p8'] }),
      ...store.settleAgent('f', { status: 'error', archivedAt: null, pending: [] }),
      ...store.settleAgent('g', { status: 'running', archivedAt: null, pending: [] }),
    ];
    assert.deepEqual(closed.map(item => [item.id, item.closedReason]).sort(), [
      ['answered', 'resolved'], ['archived', 'session-archived'], ['error-resumed', 'session-resumed'], ['gone', 'session-gone'], ['legacy', 'resolved'],
    ]);
    assert.deepEqual(store.pending().map(item => item.id).sort(), ['error-open', 'legacy-waiting', 'waiting']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('旧记录没有请求编号：从审计日志按通知编号回填，合并通知取全部提问成员', () => {
  const dir = mkdtempSync(join(tmpdir(), 'records-'));
  try {
    const store = new EscalationRecords(join(dir, 'records.json'), () => Date.parse('2026-11-08T12:00:00Z'));
    store.upsert(record('n1'));
    store.upsert(record('n2'));
    store.upsert(record('n3', { requests: [{ agentId: 'main', requestId: 'kept' }] }));
    const lines = [
      JSON.stringify({ phase: 'delivery-attempt', notice: { id: 'n1', event: 'asked', agentId: 'main', requestId: 'p1' } }),
      JSON.stringify({ phase: 'recorded-shadow', notice: { id: 'n2', event: 'asked', agentId: 'main', requestId: 'p2', events: [
        { id: 'm1', event: 'asked', agentId: 'main', requestId: 'p2' }, { id: 'm2', event: 'asked', agentId: 'x', requestId: 'p3' }, { id: 'm3', event: 'new_project', agentId: '' },
      ] } }),
      JSON.stringify({ phase: 'delivered', notice: { id: 'n3', event: 'asked', agentId: 'main', requestId: 'other' } }),
      '坏行',
    ];
    assert.equal(store.backfillRequests(lines), 2);
    const byId = new Map(store.recent().map(item => [item.id, item.requests]));
    assert.deepEqual(byId.get('n1'), [{ agentId: 'main', requestId: 'p1' }]);
    assert.deepEqual(byId.get('n2'), [{ agentId: 'main', requestId: 'p2' }, { agentId: 'x', requestId: 'p3' }]);
    assert.deepEqual(byId.get('n3'), [{ agentId: 'main', requestId: 'kept' }]);
    assert.deepEqual(store.agentsWithOpen().sort(), ['main', 'x']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('合并的出错事件：全部成员会话恢复运行、不存在、已归档或已关闭才结束', () => {
  const dir = mkdtempSync(join(tmpdir(), 'records-'));
  try {
    const store = new EscalationRecords(join(dir, 'records.json'), () => Date.parse('2026-11-08T12:00:00Z'));
    store.upsert(record('errors', { event: 'error', agentId: 'a', sessions: [{ agentId: 'a' }, { agentId: 'b' }, { agentId: 'c' }] }));
    assert.deepEqual(store.agentsWithOpen().sort(), ['a', 'b', 'c']);
    assert.deepEqual(store.settleAgent('a', { status: 'running', archivedAt: null, pending: [] }), []);
    assert.deepEqual(store.settleAgent('b', { status: 'error', archivedAt: null, pending: [] }), []);
    assert.deepEqual(store.settleAgent('c', null), []);
    assert.deepEqual(store.pending().map(item => item.id), ['errors']);
    assert.deepEqual(store.agentsWithOpen(), ['b']);
    assert.deepEqual(store.settleAgent('b', { status: 'idle', archivedAt: '2026-11-08T11:59:00.000Z', pending: [] }).map(item => [item.id, item.closedReason]), [['errors', 'session-archived']]);
    assert.deepEqual(store.pending(), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('只按会话已归档或不存在结束（守护进程刚重启，等待列表还没恢复）：其他判断都不做', () => {
  const dir = mkdtempSync(join(tmpdir(), 'records-'));
  try {
    const store = new EscalationRecords(join(dir, 'records.json'), () => Date.parse('2026-11-08T12:00:00Z'));
    store.upsert(record('q', { agentId: 'a', requests: [{ agentId: 'a', requestId: 'p1' }] }));
    store.upsert(record('legacy', { agentId: 'b' }));
    store.upsert(record('err', { agentId: 'c', event: 'error' }));
    store.upsert(record('gone', { agentId: 'd', requests: [{ agentId: 'd', requestId: 'p2' }] }));
    store.upsert(record('archived', { agentId: 'e', requests: [{ agentId: 'e', requestId: 'p3' }] }));
    const options = { onlyGone: true };
    store.settleAgent('a', { status: 'idle', archivedAt: null, pending: [] }, options);
    store.settleAgent('b', { status: 'closed', archivedAt: null, pending: [] }, options);
    store.settleAgent('c', { status: 'running', archivedAt: null, pending: [] }, options);
    store.settleAgent('d', null, options);
    store.settleAgent('e', { status: 'idle', archivedAt: '2026-11-08T11:00:00.000Z', pending: [] }, options);
    assert.deepEqual(store.pending().map(item => item.id).sort(), ['err', 'legacy', 'q']);
    assert.deepEqual(store.recent().find(item => item.id === 'q')!.requests, [{ agentId: 'a', requestId: 'p1' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
