import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const fixture = fileURLToPath(new URL('./fixtures/isolation/run.mjs', import.meta.url));
for (const scenario of ['cloud-fails', 'github-fails', 'github-runtime-fails', 'automation-fails', 'presence-fails', 'browser-fails']) {
  test(`plugin module isolation: ${scenario}`, async () => {
    const result = await run(process.execPath, ['--experimental-test-module-mocks', '--experimental-strip-types', fixture, scenario], { timeout: 10_000 });
    assert.equal(result.stdout, '');
  });
}

test('local daemon client disables reconnect and times out without blocking the next ensure', async () => {
  const connectionFixture = fileURLToPath(new URL('./fixtures/isolation/connect.mjs', import.meta.url));
  const result = await run(process.execPath, ['--experimental-test-module-mocks', '--experimental-strip-types', connectionFixture], { timeout: 12_000 });
  assert.equal(result.stdout, '');
});
