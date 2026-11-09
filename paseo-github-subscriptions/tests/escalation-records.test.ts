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
