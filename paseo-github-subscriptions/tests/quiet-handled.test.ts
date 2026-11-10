import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HandledRecords, type HandledRecord } from '../server/modules/answer-quiet-children/handled.ts';

const item = (id: string, at: string): HandledRecord => ({ id, agentId: `agent-${id}`, sessionTitle: '子会话', eventKind: 'completed', clearedAttention: true, forwardedTo: null, forwardStatus: 'no-parent', at });

test('最近处理记录按时间倒序，有数量上限，重启后保持，文件权限 0600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'handled-'));
  try {
    const path = join(dir, 'handled.json');
    const store = new HandledRecords(path, 3);
    for (const [id, at] of [['1', '2026-11-08T01:00:00Z'], ['2', '2026-11-08T02:00:00Z'], ['3', '2026-11-08T03:00:00Z'], ['4', '2026-11-08T04:00:00Z']] as const) store.add(item(id, at));
    assert.deepEqual(store.recent().map(r => r.id), ['4', '3', '2']);
    assert.deepEqual(new HandledRecords(path, 3).recent(2).map(r => r.id), ['4', '3']);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('同一会话短时间内重复清除只记一条；文件损坏时从空记录开始', () => {
  const dir = mkdtempSync(join(tmpdir(), 'handled-'));
  try {
    const path = join(dir, 'handled.json');
    const store = new HandledRecords(path, 10, () => Date.parse('2026-11-08T04:00:30Z'));
    store.add(item('1', '2026-11-08T04:00:00Z'));
    store.add({ ...item('2', '2026-11-08T04:00:20Z'), agentId: 'agent-1' });
    assert.equal(store.recent().length, 1);
    writeFileSync(path, '坏');
    assert.deepEqual(new HandledRecords(path).recent(), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
