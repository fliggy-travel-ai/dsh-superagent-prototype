import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EscalationRecords, type AgentView, type EscalationRecord } from '../server/modules/answer-escalation/records.ts';
import { EscalationReconciler, agentView } from '../server/modules/answer-escalation/reconcile.ts';

const record = (id: string, agentId: string, extra: Partial<EscalationRecord> = {}): EscalationRecord => ({
  id, event: 'asked', agentId, sessionTitle: '主会话', workspaceId: null, questionText: '是否合并？', summary: '提问：是否合并？',
  at: '2026-11-09T09:00:00.000Z', delivery: 'live', status: 'delivered', acknowledged: false, ...extra,
});

function fixture(views: Record<string, AgentView | Error>) {
  const dir = mkdtempSync(join(tmpdir(), 'reconcile-'));
  const records = new EscalationRecords(join(dir, 'records.json'), () => Date.parse('2026-11-09T12:00:00Z'));
  const audits: Record<string, unknown>[] = [];
  const lookups: string[] = [];
  const reconciler = new EscalationReconciler({
    records,
    audit: async entry => { audits.push(entry); },
    lookup: async id => { lookups.push(id); const view = views[id]; if (view instanceof Error) throw view; return view === undefined ? null : view; },
  });
  return { dir, records, audits, lookups, reconciler, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('启动对账：存量旧记录先从审计日志回填，再按会话现状结束；查询失败的保留', async () => {
  const f = fixture({
    idle: { status: 'idle', archivedAt: null, pending: [] },
    asking: { status: 'running', archivedAt: null, pending: ['new-question'] },
    flaky: new Error('连接中断'),
  });
  try {
    f.records.upsert(record('stale', 'asking'));
    f.records.upsert(record('idle-legacy', 'idle'));
    f.records.upsert(record('flaky', 'flaky', { requests: [{ agentId: 'flaky', requestId: 'p' }] }));
    f.records.upsert(record('archived-agent', 'missing', { requests: [{ agentId: 'missing', requestId: 'q' }] }));
    const audit = join(f.dir, 'events.jsonl');
    writeFileSync(audit, `${JSON.stringify({ phase: 'delivered', notice: { id: 'stale', event: 'asked', agentId: 'asking', requestId: 'old-question' } })}\n`);
    assert.equal(await f.reconciler.backfill(audit), 1);
    const closed = await f.reconciler.sweep();
    assert.deepEqual(closed.map(item => item.id).sort(), ['archived-agent', 'idle-legacy', 'stale']);
    assert.deepEqual(f.records.pending().map(item => item.id), ['flaky']);
    assert.deepEqual(f.audits.map(entry => [entry.phase, entry.id, entry.reason]).sort(), [
      ['record-closed', 'archived-agent', 'session-gone'], ['record-closed', 'idle-legacy', 'resolved'], ['record-closed', 'stale', 'resolved'],
    ]);
    // 全部结束后不再查询这些会话。
    f.lookups.length = 0;
    await f.reconciler.sweep();
    assert.deepEqual(f.lookups, ['flaky']);
  } finally { f.done(); }
});

test('权限钩子结束提问时立即移出待办并写审计；订阅推送的会话快照也能结束', async () => {
  const f = fixture({});
  try {
    f.records.upsert(record('a', 'main', { requests: [{ agentId: 'main', requestId: 'p1' }] }));
    f.records.upsert(record('b', 'main', { requests: [{ agentId: 'main', requestId: 'p2' }] }));
    await f.reconciler.closeRequest('main', 'p1');
    assert.deepEqual(f.records.pending().map(item => item.id), ['b']);
    assert.deepEqual(f.audits.map(entry => [entry.phase, entry.id, entry.requestId]), [['record-closed', 'a', 'p1']]);
    await f.reconciler.settle('main', agentView({ status: 'running', archivedAt: null, pendingPermissions: [{ id: 'p2' }] }));
    assert.deepEqual(f.records.pending().map(item => item.id), ['b']);
    await f.reconciler.settle('main', agentView({ status: 'idle', pendingPermissions: [] }));
    assert.deepEqual(f.records.pending(), []);
  } finally { f.done(); }
});
