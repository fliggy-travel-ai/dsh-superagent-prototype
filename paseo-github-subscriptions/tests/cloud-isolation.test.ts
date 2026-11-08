import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const fixture = fileURLToPath(new URL('./fixtures/isolation/run.mjs', import.meta.url));
for (const scenario of ['cloud-fails', 'github-fails']) {
  test(`plugin module isolation: ${scenario}`, async () => {
    const result = await run(process.execPath, ['--experimental-test-module-mocks', '--experimental-strip-types', fixture, scenario], { timeout: 10_000 });
    assert.equal(result.stdout, '');
  });
}
