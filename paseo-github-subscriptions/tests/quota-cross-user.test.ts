import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
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

const renewalMappings = () => ({ [dir]: { command: '/trusted/launch', args: ['--usage'],
  renewal: { cwd: '/trusted/workspace', probeArgs: ['--egress'] },
} });
test('隔离用户先核对出口，再官方初始化，最后查询；并发与缓存覆盖完整流程', async () => {
  const actions: string[] = [];
  let tokenExpired = true;
  const usage = new CrossUserUsage({ mappings: renewalMappings,
    initialize: async (command, cwd, timeout) => {
      assert.equal(command, '/trusted/launch'); assert.equal(cwd, '/trusted/workspace'); assert.ok(timeout <= 6000);
      actions.push('initialize'); tokenExpired = false; return true;
    },
    run: async (command, args) => {
      assert.equal(command, '/trusted/launch');
      if (args[0] === '--egress') { actions.push('probe'); return JSON.stringify({ verified: true }); }
      actions.push('usage');
      return JSON.stringify(tokenExpired ? { version: 1, error: 'http-401' } : reply);
    },
  });
  const [first, second] = await Promise.all([usage.fetch(dir, 'account.org'), usage.discover(dir)]);
  assert.equal(first.status, 'available'); assert.equal(second[0].key, 'account.org');
  await usage.fetch(dir, 'account.org');
  assert.deepEqual(actions, ['probe', 'initialize', 'usage']);
});
test('隔离用户出口预检失败时不续期、不发送账号请求', async () => {
  for (const error of ['egress-mismatch', 'egress-timeout', 'egress-invalid-response']) {
    let calls = 0;
    const usage = new CrossUserUsage({ mappings: renewalMappings,
      initialize: async () => assert.fail('出口失败不能续期'),
      run: async (_command, args) => { calls++; assert.deepEqual(args, ['--egress']); return JSON.stringify({ version: 1, error }); },
    });
    const result = await usage.fetch(dir, 'account.org');
    assert.equal(result.status, 'error'); assert.equal(calls, 1);
  }
});
test('初始化确认不能代替真实账号结果，失败也不阻止尚有效的凭据查询', async () => {
  for (const initialized of [true, false]) {
    for (const response of [reply, { version: 1, error: 'http-401' }, { version: 1, error: 'keychain' }]) {
      const usage = new CrossUserUsage({ mappings: renewalMappings,
        initialize: async () => initialized,
        run: async (_command, args) => JSON.stringify(args[0] === '--egress' ? { verified: true } : response),
      });
      const result = await usage.fetch(dir, 'account.org');
      assert.equal(result.status, 'error' in response ? 'error' : 'available');
      if (result.status === 'error') assert.match(result.error, 'error' in response && response.error === 'http-401' ? /HTTP 401/ : /钥匙串/);
    }
  }
});
test('预检、初始化和查询共用十八秒预算，预算耗尽时不查询', async () => {
  let now = 0;
  const timeouts: number[] = [];
  const usage = new CrossUserUsage({ mappings: renewalMappings, now: () => now,
    initialize: async (_command, _cwd, timeout) => { assert.equal(timeout, 6000); now += 5000; return true; },
    run: async (_command, args, timeout) => {
      timeouts.push(timeout);
      if (args[0] === '--egress') { now += 4000; return JSON.stringify({ verified: true }); }
      return JSON.stringify(reply);
    },
  });
  assert.equal((await usage.fetch(dir, 'account.org')).status, 'available');
  assert.deepEqual(timeouts, [4000, 9000]);
  const exhausted = new CrossUserUsage({ mappings: renewalMappings, now: () => now,
    initialize: async () => { now += 18_000; return false; },
    run: async (_command, args) => { assert.deepEqual(args, ['--egress']); return JSON.stringify({ verified: true }); },
  });
  assert.equal((await exhausted.fetch(dir, 'account.org')).status, 'error');
});
test('隔离用户429冷却跨重载保留，冷却期间不运行预检或续期', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'quota-renewal-backoff-'));
  let now = 0;
  let initializations = 0;
  let probes = 0;
  const options = { mappings: renewalMappings, cacheFile: join(temp, 'cache.json'), now: () => now,
    initialize: async () => { initializations++; return true; },
    run: async (_command: string, args: string[]) => {
      if (args[0] === '--egress') { probes++; return JSON.stringify({ verified: true }); }
      return JSON.stringify({ ...reply, error: 'http-429' });
    },
  };
  try {
    await new CrossUserUsage(options).fetch(dir, 'account.org');
    now = 899_999;
    const reloaded = new CrossUserUsage(options);
    await reloaded.discover(dir); await reloaded.fetch(dir, 'account.org');
    assert.equal(initializations, 1); assert.equal(probes, 1);
    now = 900_000;
    await reloaded.fetch(dir, 'account.org');
    assert.equal(initializations, 2); assert.equal(probes, 2);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
test('真实配置文件兼容旧映射并接受显式续期配置', () => {
  const temp = mkdtempSync(join(tmpdir(), 'quota-renewal-mapping-'));
  try {
    const file = join(temp, 'cross-user-providers.json');
    writeFileSync(file, JSON.stringify({ ...mappings(), '/Users/second/.claude': renewalMappings()[dir] }));
    const usage = new CrossUserUsage({ directory: temp });
    assert.equal(usage.handles(dir), true); assert.equal(usage.handles('/Users/second/.claude'), true);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
test('初始化抛错后仍查询有效凭据，旧映射完全跳过初始化', async () => {
  const usage = new CrossUserUsage({ mappings: renewalMappings,
    initialize: async () => { throw new Error('fake failure'); },
    run: async (_command, args) => JSON.stringify(args[0] === '--egress' ? { verified: true } : reply),
  });
  assert.equal((await usage.fetch(dir, 'account.org')).status, 'available');
  const legacy = new CrossUserUsage({ mappings, initialize: async () => assert.fail('旧映射不能初始化'),
    run: async (_command, args) => { assert.deepEqual(args, ['--usage']); return JSON.stringify(reply); },
  });
  assert.equal((await legacy.fetch(dir, 'account.org')).status, 'available');
});
test('剩余预算少于三秒时不启动额度helper', async () => {
  let now = 0;
  const usage = new CrossUserUsage({ mappings: renewalMappings, now: () => now,
    initialize: async () => { now = 15_001; return false; },
    run: async (_command, args) => { assert.deepEqual(args, ['--egress']); return JSON.stringify({ verified: true }); },
  });
  assert.equal((await usage.fetch(dir, 'account.org')).status, 'error');
});
test('无效出口响应安全归类，预检429保留十五分钟冷却', async () => {
  for (const output of ['not-json', 'null', JSON.stringify({ error: 'unknown-sensitive-value' }), JSON.stringify({ error: 'http-429' })]) {
    let calls = 0;
    let now = 0;
    const usage = new CrossUserUsage({ mappings: renewalMappings, now: () => now,
      initialize: async () => assert.fail('无效出口不能初始化'),
      run: async () => { calls++; return output; },
    });
    const report = await usage.fetch(dir, 'account.org');
    assert.equal(report.status, 'error');
    assert.equal(JSON.stringify(report).includes('unknown-sensitive-value'), false);
    if (output.includes('http-429')) { now = 899_999; await usage.fetch(dir, 'account.org'); assert.equal(calls, 1); }
  }
});
test('真实配置拒绝相对目录、空预检参数和未知续期字段', () => {
  const temp = mkdtempSync(join(tmpdir(), 'quota-invalid-renewal-'));
  try {
    for (const renewal of [{ cwd: 'relative', probeArgs: ['--egress'] }, { cwd: '/workspace', probeArgs: [] }, { cwd: '/workspace', probeArgs: ['--egress'], unknown: true }]) {
      writeFileSync(join(temp, 'cross-user-providers.json'), JSON.stringify({ [dir]: { ...mappings()[dir], renewal } }));
      assert.equal(new CrossUserUsage({ directory: temp }).handles(dir), false);
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('独立用户连续429按十五、三十、六十分钟退避，重载不清除连续次数', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'quota-progressive-'));
  const cacheFile = join(temp, 'cache.json'); let now=0, calls=0;
  const options = { mappings, cacheFile, now:()=>now, run:async()=>{ calls++;return JSON.stringify({...reply,error:'http-429'}); } };
  try {
    await new CrossUserUsage(options).discover(dir);
    now=900000;await new CrossUserUsage(options).discover(dir);assert.equal(calls,2);
    now=2699999;await new CrossUserUsage(options).discover(dir);assert.equal(calls,2);
    now=2700000;await new CrossUserUsage(options).discover(dir);assert.equal(calls,3);
    now=6299999;await new CrossUserUsage(options).discover(dir);assert.equal(calls,3);
    now=6300000;await new CrossUserUsage(options).discover(dir);assert.equal(calls,4);
  } finally {rmSync(temp,{recursive:true,force:true});}
});
