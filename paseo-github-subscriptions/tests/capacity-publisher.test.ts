import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { shouldPublish, signature } from '../server/modules/capacity/publisher.ts';
test('签名含实时状态，变化间隔五分钟，六小时心跳', () => {
  const accounts = [{ provider: 'claude-1', canAdd: 0, live: true }];
  const first = signature(accounts); const next = signature([{ ...accounts[0]!, live: false }]);
  assert.notEqual(first, next); assert.equal(shouldPublish(null, first, 0), true);
  const previous = { signature: first, sentAt: 1000 };
  assert.equal(shouldPublish(previous, next, 1000 + 299_999), false);
  assert.equal(shouldPublish(previous, next, 1000 + 300_000), true);
  assert.equal(shouldPublish(previous, first, 1000 + 6 * 3600_000 - 1), false);
  assert.equal(shouldPublish(previous, first, 1000 + 6 * 3600_000), true);
});
test('同一小时从原余量变化再变回时，使用不同投递键', async () => {
  const { publicationKey } = await import('../server/modules/capacity/publisher.ts');
  const value = signature([{ provider: 'claude-1', canAdd: 1, live: true }]);
  assert.notEqual(publicationKey(value), publicationKey(value));
});
test('清理过期容量和异常去重键，保留近期记录及其他事件', async () => {
  const { pruneAutomationSeen } = await import('../server/modules/dispatch-finalize/notifier.ts');
  const now = 100_000_000;
  const seen: Record<string, number> = { 'capacity:old': now - 86_400_001, 'lb_exception:old': now - 86_400_000, 'capacity:new': now - 1000, 'main_migrated:old': now - 86_400_000, 'main_migration_planned:old': now - 86_400_001, 'main_migrated:new': now - 1000, 'main_migration_planned:new': now - 1000, 'main_finalized:old': 1 };
  assert.equal(pruneAutomationSeen(seen, now), true);
  assert.deepEqual(seen, { 'capacity:new': now - 1000, 'main_migrated:new': now - 1000, 'main_migration_planned:new': now - 1000, 'main_finalized:old': 1 });
});
