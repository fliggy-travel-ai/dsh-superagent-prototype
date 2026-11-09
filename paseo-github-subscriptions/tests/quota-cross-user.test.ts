import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrossUserUsage } from '../server/modules/usage-claude-accounts/cross-user.ts';
const dir = '/Users/pilot/.claude';
const reply = { version: 1, account: { key: 'account.org', label: 'pilot@example.com' }, plan: 'pro', windows: [
  { id: 'five_hour', label: 'Session', shortLabel: '5h', summary: true, utilization: 12, resetsAt: '2026-11-06T06:00:00Z' },
] };
const mappings = () => ({ [dir]: { command: '/trusted/launch', args: ['--usage'] } });
test('跨用户查询仅执行管理员配置的命令，合并并缓存查询', async () => {
  let calls = 0;
  const usage = new CrossUserUsage({ mappings, run: async (command, args) => {
    calls++; assert.equal(command, '/trusted/launch'); assert.deepEqual(args, ['--usage']);
    return JSON.stringify(reply);
  } });
  const [a,b] = await Promise.all([usage.discover(dir),usage.discover(dir)]);
  assert.equal(a[0].key, b[0].key); assert.equal(calls, 1);
  const result = await usage.fetch(dir, 'account.org'); assert.equal(result.status, 'available');
  assert.equal(calls, 1);
  await assert.rejects(usage.fetch('/attacker/command', 'account.org'));
  assert.equal(calls, 1);
});
test('正常查询至少间隔五分钟，发现账号和面板刷新共享缓存', async () => {
  let now = 0, calls = 0;
  const usage = new CrossUserUsage({ mappings, now: () => now, run: async () => { calls++; return JSON.stringify(reply); } });
  await usage.discover(dir);
  now = 299_999;
  await usage.discover(dir); await usage.fetch(dir, 'account.org');
  assert.equal(calls, 1);
  now = 300_000;
  await usage.fetch(dir, 'account.org'); assert.equal(calls, 2);
});
test('429 等待十五分钟，插件重载和面板刷新不能绕过，缓存不含凭据', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'quota-backoff-'));
  const cacheFile = join(temp, 'cache.json');
  let now = 0, calls = 0;
  const options = { mappings, cacheFile, now: () => now, run: async () => {
    calls++; return JSON.stringify({ ...reply, windows: [], error: 'http-429', accessToken: 'must-not-persist' });
  } };
  try {
    const usage = new CrossUserUsage(options);
    await usage.discover(dir);
    assert.equal(statSync(cacheFile).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(cacheFile, 'utf8'), /must-not-persist|accessToken/);
    now = 899_999;
    const reloaded = new CrossUserUsage(options);
    assert.equal((await reloaded.discover(dir))[0].key, 'account.org');
    const result = await reloaded.fetch(dir, 'account.org');
    if (result.status !== 'error') assert.fail('需要显示限流');
    assert.match(result.error, /HTTP 429/); assert.equal(calls, 1);
    now = 900_000;
    await reloaded.fetch(dir, 'account.org'); assert.equal(calls, 2);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
test('接口网络、登录和钥匙串失败使用不同提示', async () => {
  for (const [error, pattern] of [['network', /连接失败或超时/], ['http-401', /HTTP 401/], ['http-403', /HTTP 403/], ['keychain', /钥匙串/]] as const) {
    const usage = new CrossUserUsage({ mappings, run: async () => JSON.stringify({ version: 1, error }) });
    const result = await usage.fetch(dir, 'account.org');
    if (result.status !== 'error') assert.fail('需要显示失败');
    assert.match(result.error, pattern);
  }
});
test('登录账号变化时不将新账号额度交给旧卡片', async () => {
  const usage = new CrossUserUsage({ mappings, run: async () => JSON.stringify(reply) });
  assert.equal((await usage.fetch(dir, 'previous.org')).status, 'error');
});
test('出口不符时报告失败，不伪造额度', async () => {
  const usage = new CrossUserUsage({ mappings, run: async () => JSON.stringify({ version: 1, error: 'egress-mismatch' }) });
  const result = await usage.fetch(dir, 'account.org');
  assert.equal(result.status, 'error');
  if (result.status === 'error') assert.match(result.error, /未发送账号额度请求/);
});
test('拒绝无效用量，子进程错误及额外凭据字段不泄露', async () => {
  const malformed = new CrossUserUsage({ mappings, run: async () => JSON.stringify({ ...reply, windows: [{ ...reply.windows[0], utilization: 900 }] }) });
  assert.equal((await malformed.fetch(dir,'account.org')).status, 'error');
  const failed = new CrossUserUsage({ mappings, run: async () => { throw new Error('secret-value'); } });
  assert.doesNotMatch(JSON.stringify(await failed.fetch(dir,'account.org')), /secret-value/);
  const extra = new CrossUserUsage({ mappings, run: async () => JSON.stringify({ ...reply, accessToken: 'secret-value' }) });
  assert.doesNotMatch(JSON.stringify(await extra.discover(dir)), /secret-value/);
});
test('出口探测超时和 IP 不一致使用不同提示', async () => {
  for (const [error, expected] of [['egress-timeout', /出口探测超时/], ['egress-mismatch', /实际出口与预期 IP 不一致/], ['egress-probe-failed', /连接失败/], ['egress-invalid-response', /未返回有效 IP/]] as const) {
    const usage = new CrossUserUsage({ mappings, run: async () => JSON.stringify({ version: 1, error }) });
    const result = await usage.fetch(dir, 'account.org');
    assert.equal(result.status, 'error');
    if (result.status === 'error') assert.match(result.error, expected);
  }
});
