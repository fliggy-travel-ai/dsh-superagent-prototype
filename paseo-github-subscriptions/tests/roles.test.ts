import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const fixture = fileURLToPath(new URL('./fixtures/roles/run.mjs', import.meta.url));
for (const role of ['provider', 'main', 'legacy']) {
  test(`实例角色 ${role}：只注册该角色的模块`, async () => {
    const result = await run(process.execPath, ['--experimental-test-module-mocks', '--experimental-strip-types', fixture, role], { timeout: 15_000 });
    assert.equal(result.stdout, '');
  });
}
