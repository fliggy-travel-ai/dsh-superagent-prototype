import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateLegacyEscalation } from '../server/modules/answer-escalation/migrate.ts';

test('复制状态和额度报警记录，不复制事件日志；旧文件保持不动；只给配置建议不写机器配置', () => {
  const root = mkdtempSync(join(tmpdir(), 'esc-migrate-'));
  try {
    const old = join(root, 'event-notifications'); const next = join(root, 'new', 'escalation');
    mkdirSync(join(old, 'rollback'), { recursive: true });
    writeFileSync(join(old, 'state.json'), '{"pending":{},"outbox":[],"seen":{"a":1}}');
    writeFileSync(join(old, 'quota-alerts.json'), '{"active":{}}');
    writeFileSync(join(old, 'events.jsonl'), '{}\n');
    writeFileSync(join(old, 'config.json'), JSON.stringify({ hostId: 'macmini', machine: 'macmini', delivery: 'live', mains: [], children: {}, hostMachines: { srv_a: 'macmini' }, mainAgentsFile: '/tmp/main-agents.tsv', webhook: { urlEnv: 'GROK_URL', authEnv: 'GROK_AUTH' }, coalesceWindowSeconds: 60 }));
    const result = migrateLegacyEscalation(old, next);
    assert.deepEqual(result.report.copied.sort(), ['quota-alerts.json', 'state.json']);
    assert.equal(existsSync(join(next, 'events.jsonl')), false);
    assert.equal(readFileSync(join(old, 'state.json'), 'utf8').includes('"seen"'), true);
    assert.deepEqual(JSON.parse(readFileSync(join(next, 'state.json'), 'utf8')).seen, { a: 1 });
    assert.deepEqual(result.suggestion, { webhook: { urlEnv: 'GROK_URL', authEnv: 'GROK_AUTH' } });
    assert.equal(result.notes.join('\n').includes('影子'), false);
    assert.match(result.notes.join('\n'), /quotaAlerts\.fileDirectory/);
    assert.equal(existsSync(join(root, 'new', 'machine.json')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('旧目录不存在或配置损坏时不报错', () => {
  const root = mkdtempSync(join(tmpdir(), 'esc-migrate-'));
  try {
    assert.equal(migrateLegacyEscalation(join(root, 'nope'), join(root, 'x')).suggestion, null);
    mkdirSync(join(root, 'old'));
    writeFileSync(join(root, 'old', 'config.json'), '{坏');
    assert.equal(migrateLegacyEscalation(join(root, 'old'), join(root, 'y')).suggestion, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
