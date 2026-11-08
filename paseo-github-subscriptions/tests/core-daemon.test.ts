import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedDaemon } from '../server/core/daemon.ts';

type Fake = { id: number; closed: boolean; close: () => Promise<void> };
const fake = (id: number): Fake => { const value: Fake = { id, closed: false, close: async () => { value.closed = true; } }; return value; };

test('多个模块共用一个连接，只连接一次', async () => {
  let calls = 0;
  const daemon = new SharedDaemon<Fake>('/home', async () => fake(++calls));
  const [a, b] = await Promise.all([daemon.ready(), daemon.ready()]);
  assert.equal(a, b);
  assert.equal(calls, 1);
  assert.equal(daemon.current(), a);
});

test('连接失败后下次调用重试', async () => {
  let calls = 0;
  const daemon = new SharedDaemon<Fake>('/home', async () => { calls++; if (calls === 1) throw new Error('尚未写入监听地址'); return fake(calls); });
  await assert.rejects(daemon.ready(), /尚未写入监听地址/);
  assert.equal(daemon.current(), null);
  assert.equal((await daemon.ready()).id, 2);
});

test('连接函数收到停止信号；关闭后拒绝新的调用并关闭已有连接', async () => {
  let signal: AbortSignal | undefined;
  const daemon = new SharedDaemon<Fake>('/home', async (_home, given) => { signal = given; return fake(1); });
  const connection = await daemon.ready();
  await daemon.close();
  assert.equal(signal?.aborted, true);
  assert.equal(connection.closed, true);
  await assert.rejects(daemon.ready(), /插件已停止/);
});

test('关闭时正在连接：连接完成后立即关闭，不交给调用方', async () => {
  let release: (value: Fake) => void = () => {};
  const pending = fake(1);
  const daemon = new SharedDaemon<Fake>('/home', () => new Promise(resolve => { release = resolve; }));
  const waiting = daemon.ready();
  const closing = daemon.close();
  release(pending);
  await assert.rejects(waiting, /插件已停止/);
  await closing;
  assert.equal(pending.closed, true);
});
