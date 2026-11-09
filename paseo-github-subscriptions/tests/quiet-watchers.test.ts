import test from 'node:test';
import assert from 'node:assert/strict';
import { TimelineWatchers } from '../server/modules/answer-quiet-children/watchers.ts';

const fake = () => {
  const log: string[] = [];
  const open = (id: string, ready: Promise<unknown> = Promise.resolve()) => () => { log.push(`open:${id}`); return { ready, stop: () => { log.push(`stop:${id}`); } }; };
  return { log, open };
};

test('同一个会话只订阅一次；释放后可以再订阅', async () => {
  const { log, open } = fake();
  const watchers = new TimelineWatchers();
  await watchers.watch('a', open('a')); await watchers.watch('a', open('a'));
  assert.deepEqual(log, ['open:a']);
  assert.equal(watchers.has('a'), true);
  watchers.release('a');
  assert.deepEqual(log, ['open:a', 'stop:a']);
  await watchers.watch('a', open('a'));
  assert.deepEqual(log, ['open:a', 'stop:a', 'open:a']);
});

test('订阅建立中就被释放：建立完成后立刻取消，不遗留', async () => {
  const { log, open } = fake();
  const watchers = new TimelineWatchers();
  let finish!: () => void;
  const pending = watchers.watch('a', open('a', new Promise<void>(resolve => { finish = resolve; })));
  watchers.release('a');
  finish(); await pending;
  assert.deepEqual(log, ['open:a', 'stop:a']);
  assert.equal(watchers.has('a'), false);
});

test('订阅失败时不留记录，下次可以重试；全部释放', async () => {
  const { log, open } = fake();
  const watchers = new TimelineWatchers();
  await assert.rejects(watchers.watch('bad', open('bad', Promise.reject(new Error('断开')))), /断开/);
  assert.equal(watchers.has('bad'), false);
  await watchers.watch('a', open('a')); await watchers.watch('b', open('b'));
  watchers.releaseAll();
  assert.deepEqual(log.filter(line => line.startsWith('stop:')).sort(), ['stop:a', 'stop:b', 'stop:bad']);
  assert.deepEqual(watchers.ids(), []);
});
