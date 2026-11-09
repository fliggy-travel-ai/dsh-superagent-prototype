import test from 'node:test';
import assert from 'node:assert/strict';
import { Attempt } from '../server/core/attempt.ts';

test('取消时依次执行已登记的清理函数，各执行一次，单个出错不影响其他', () => {
  const attempt = new Attempt(); const log: string[] = [];
  attempt.add(() => log.push('a')); attempt.add(() => { throw new Error('坏'); }); attempt.add(() => log.push('c'));
  attempt.cancel(); attempt.cancel();
  assert.deepEqual(log, ['c', 'a']);
  assert.equal(attempt.cancelled, true);
});

test('取消之后才登记的清理函数立即执行，不遗留', () => {
  const attempt = new Attempt(); const log: string[] = [];
  attempt.cancel();
  attempt.add(() => log.push('late'));
  assert.deepEqual(log, ['late']);
});

test('check 在取消后抛错，用在每次 await 之后', async () => {
  const attempt = new Attempt();
  attempt.check();
  await Promise.resolve();
  attempt.cancel();
  assert.throws(() => attempt.check(), /已停止/);
});
