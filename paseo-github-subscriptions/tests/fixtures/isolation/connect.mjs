import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';

const home = await mkdtemp(join(tmpdir(), 'cloud-provider-test-'));
let count = 0; let closed = 0;
try {
  await writeFile(join(home, 'paseo.pid'), JSON.stringify({ listen: 'ws://127.0.0.1:1' }));
  process.env.PASEO_HOME = home;
  mock.module('@getpaseo/client/node', { namedExports: { createHostClient: (_address, options) => {
    assert.deepEqual(options.reconnect, { enabled: false }); count++;
    return { connect: count === 1 ? () => new Promise(() => {}) : async () => { throw new Error('connection refused'); }, close: async () => { closed++; } };
  } } });
  const { createCloudSession } = await import('../../../server/cloud-session/index.ts');
  const cloud = createCloudSession();
  const input = { cloudSessionId: 'cse_abcdefgh1234', title: 'test', cwd: '/tmp' };
  const started = Date.now();
  const first = cloud.ensure(input, {}); const second = cloud.ensure(input, {});
  await assert.rejects(first, /连接本机 daemon 超时/);
  await assert.rejects(second, /本机 daemon 连接失败/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 4900 && elapsed < 9000);
  assert.equal(count, 2); assert.equal(closed, 2);
  cloud.dispose();
} finally {
  mock.reset();
  await rm(home, { recursive: true, force: true });
}
