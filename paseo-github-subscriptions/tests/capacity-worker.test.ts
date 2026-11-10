import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MigrationWorker } from '../server/modules/capacity/worker.ts';

test('等待迁移确认时余量发送可继续，并合并迁移触发', async () => {
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  let starts = 0; let publications = 0;
  const worker = new MigrationWorker(async () => { starts++; if (starts === 1) await wait; });
  worker.request(); worker.request(); worker.request();
  await Promise.resolve();
  await Promise.resolve().then(() => { publications++; });
  assert.equal(publications, 1); assert.equal(starts, 1);
  release();
  for (let i = 0; i < 10 && starts < 2; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 2); await worker.stop();
});
