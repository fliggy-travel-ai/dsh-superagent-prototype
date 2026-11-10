import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { calculate, targets, tierOf, type Input } from '../server/modules/capacity/model.ts';
const now = Date.parse('2026-01-01T02:30:00Z');
const base = (): Input => ({ provider: 'claude-1', now, agents: [], report: { fetchedAt: new Date(now).toISOString(), report: { status: 'available', planLabel: 'Max 5x', windows: [{ id: 'five_hour', remainingPct: 50, resetsAt: '2026-01-01T05:00:00Z' }, { id: 'weekly', remainingPct: 60 }] } } });
test('档次以实时 planLabel 为准，并排除冲突和未知 Max', () => {
  assert.equal(tierOf('Max 5x').tier, 'max'); assert.equal(tierOf('Pro ai').tier, 'pro');
  assert.equal(tierOf('Max 20x').tier, null); assert.equal(tierOf('Pro ai', 'max').tier, null); assert.equal(tierOf(null).tier, null);
});
test('历史额度不参与决策，窗口未开始时 pace 为零', () => {
  const i = base(); i.report!.fetchedAt = new Date(now - 11 * 60_000).toISOString();
  assert.equal(calculate(i).canAdd, 0); assert.equal(calculate(i).live, false);
  const j = base(); j.report!.report!.windows![0]!.resetsAt = null;
  assert.equal(calculate(j).pace, 0); assert.equal(calculate(j).canAdd, 4);
});
test('pace、预热和负载影响余量，耗尽或周额度不足不分配', () => {
  const i = base(); i.report!.report!.windows![0]!.remainingPct = 25; i.agents = [{ id: 'a', status: 'running' }];
  assert.equal(calculate(i).effectiveCap, 2); assert.equal(calculate(i).canAdd, 1);
  i.warmup = true; assert.equal(calculate(i).canAdd, 0);
  i.report!.report!.windows![1]!.remainingPct = 5; assert.equal(calculate(i).effectiveCap, 0);
});
test('目标按余量、周额度、Max 排序并排除不合格账号', () => {
  const a = base(); const b = base(); b.provider = 'claude-2'; b.report!.report!.planLabel = 'Pro ai';
  assert.deepEqual(targets([calculate(b), calculate(a)], '').map(x => x.provider), ['claude-1', 'claude-2']);
  a.report!.report!.windows![0]!.remainingPct = 29; assert.deepEqual(targets([calculate(a)], ''), []);
});
