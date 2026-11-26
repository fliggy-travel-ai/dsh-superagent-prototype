import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// usage.ts 在加载时读取 PASEO_HOME，所以先指到临时目录再动态加载。
const root = mkdtempSync(join(tmpdir(), 'ghsub-usage-test-'));
process.env.PASEO_HOME = join(root, '.paseo');
for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete process.env[key];
const net = await import('../server/modules/usage-provider-quotas/server/net.ts');
const usage = await import('../server/modules/usage-provider-quotas/server/usage.ts');
const source = (id: string) => usage.createUsageSources().find(item => item.id === id)!;

const jwt = (exp: number) => `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.y`;
const expired = () => jwt(Math.floor(Date.now() / 1000) - 3600);

test('Codex 会话使用实际登录目录匹配账号，不误标为默认 Provider', async () => {
  const defaultHome = join(root, '.codex');
  const accountHome = join(root, '.codex-other');
  mkdirSync(process.env.PASEO_HOME!, { recursive: true });
  for (const [directory, email] of [[defaultHome, 'default@example.com'], [accountHome, 'other@example.com']]) {
    mkdirSync(directory!, { recursive: true });
    writeFileSync(join(directory!, 'auth.json'), JSON.stringify({ tokens: { id_token: `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.y` } }));
  }
  writeFileSync(join(process.env.PASEO_HOME!, 'config.json'), JSON.stringify({ agents: { providers: {
    codex: {},
    'codex-disabled': { extends: 'codex', enabled: false, env: { CODEX_HOME: accountHome } },
    'codex-5': { extends: 'codex', env: { CODEX_HOME: accountHome, HTTPS_PROXY: 'http://configured-proxy:8080' } },
  } } }));
  const accounts = await source('codex-multi').discover({ kind: 'session', provider: 'codex', env: { HOME: root, CODEX_HOME: accountHome } });
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]!.key, 'codex-5');
  assert.equal(accounts[0]!.label, 'other@example.com (codex-5)');
  assert.equal((accounts[0]!.input as { authPath: string }).authPath, join(accountHome, 'auth.json'));
  const aliasAccounts = await source('codex-multi').discover({ kind: 'session', provider: 'codex-5', env: {} });
  assert.equal(aliasAccounts[0]!.label, 'other@example.com (codex-5)');
  assert.equal((aliasAccounts[0]!.input as { proxyUrl: string }).proxyUrl, 'http://configured-proxy:8080');
  const sessionProxy = await source('codex-multi').discover({ kind: 'session', provider: 'codex-5', env: { HTTP_PROXY: 'http://session-proxy:8080' } });
  assert.equal((sessionProxy[0]!.input as { proxyUrl: string }).proxyUrl, 'http://session-proxy:8080');
  const changedHome = await source('codex-multi').discover({ kind: 'session', provider: 'codex-5', env: { HOME: root } });
  assert.equal((changedHome[0]!.input as { authPath: string }).authPath, join(defaultHome, 'auth.json'));
  const apiAccounts = await source('codex-multi').discover({ kind: 'session', provider: 'codex', env: { HOME: root, OPENAI_BASE_URL: 'https://api.example.com' } });
  assert.deepEqual(apiAccounts, []);
  const otherProvider = await source('codex-multi').discover({ kind: 'session', provider: 'claude', env: { HOME: root } });
  assert.deepEqual(otherProvider, []);

  const globalCodex = await source('codex-multi').discover({ kind: 'global' });
  assert.deepEqual(globalCodex.map(account => account.key), ['codex-5']);

  const agyHome = join(root, 'agy-cy');
  const agyAuth = join(agyHome, '.gemini', 'antigravity-cli');
  mkdirSync(agyAuth, { recursive: true });
  writeFileSync(join(agyAuth, 'antigravity-oauth-token'), JSON.stringify({ token: { access_token: 'x' } }));
  mkdirSync(join(root, '.gemini', 'antigravity-cli'), { recursive: true });
  writeFileSync(join(root, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), JSON.stringify({ token: { access_token: 'y' } }));
  writeFileSync(join(process.env.PASEO_HOME!, 'config.json'), JSON.stringify({ agents: { providers: {
    codex: {},
    'codex-5': { extends: 'codex', env: { CODEX_HOME: accountHome } },
    antigravity: { env: { HOME: root } },
    'antigravity-cy517': { env: { HOME: agyHome }, label: 'Antigravity · cy@example.com' },
    'antigravity-off': { enabled: false, env: { HOME: agyHome } },
  } } }));
  const globalAgy = await source('antigravity-multi').discover({ kind: 'global' });
  assert.deepEqual(globalAgy.map(account => account.key), ['antigravity-cy517']);
  assert.equal(globalAgy[0]!.label, 'cy@example.com (antigravity-cy517)');
  const officialAgySession = await source('antigravity-multi').discover({ kind: 'session', provider: 'antigravity', env: { HOME: root } });
  assert.deepEqual(officialAgySession, []);
});

/** 替换 http(s).request：记录调用，按处理函数返回响应。 */
function fakeTransport(handler: (url: URL, init: any, body: string) => { status: number; body: string } | Error) {
  const calls: string[] = [];
  const originals = { http: http.request, https: https.request };
  net.setScutilRunnerForTest(() => '');
  const make = (label: string) => ((...args: any[]) => {
    // 两种调用形式：request(URL, 选项, 回调) 和 request(选项)。
    const [target, init, callback] = args[0] instanceof URL ? args : [args[0], args[0], args[1]];
    const req = new EventEmitter() as any;
    let body = '';
    const url = target instanceof URL ? target : new URL(`https://${init?.hostname ?? init?.host}${init?.path ?? ''}`);
    req.setTimeout = () => req;
    req.write = (chunk: string) => { body += chunk; };
    req.destroy = () => {};
    req.end = () => {
      calls.push(`${label} ${init?.method ?? 'GET'} ${init?.method === 'CONNECT' ? init.path : url.href}`);
      const result = handler(url, init, body);
      setImmediate(() => {
        if (result instanceof Error) { req.emit('error', result); return; }
        const res = new EventEmitter() as any;
        res.statusCode = result.status;
        if (typeof callback === 'function') callback(res);
        res.emit('data', Buffer.from(result.body));
        res.emit('end');
      });
    };
    return req;
  }) as never;
  http.request = make('http');
  https.request = make('https');
  return { calls, restore() { http.request = originals.http; https.request = originals.https; net.setScutilRunnerForTest(null); } };
}

test('系统代理：优先读 HTTPS，遵守例外列表，只读 scutil 一次且出错不抛', () => {
  const output = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
    2 : internal.example.com
  }
  HTTPEnable : 1
  HTTPPort : 8080
  HTTPProxy : 10.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 8443
  HTTPSProxy : 10.0.0.2
}`;
  assert.equal(net.parseScutilProxy(output, 'api.example.com'), 'http://10.0.0.2:8443');
  assert.equal(net.parseScutilProxy(output, 'printer.local'), null);
  assert.equal(net.parseScutilProxy(output, '169.254.1.1'), null);
  assert.equal(net.parseScutilProxy(output, 'internal.example.com'), null);
  assert.equal(net.parseScutilProxy('HTTPEnable : 1\nHTTPPort : 3128\nHTTPProxy : 10.0.0.1', 'a.com'), 'http://10.0.0.1:3128');
  assert.equal(net.parseScutilProxy('HTTPEnable : 0\nHTTPProxy : 10.0.0.1\nHTTPPort : 1', 'a.com'), null);

  let runs = 0;
  net.setScutilRunnerForTest(() => { runs++; throw new Error('scutil 超时'); });
  assert.equal(net.getSystemProxy('a.com'), null);
  assert.equal(net.getSystemProxy('b.com'), null);
  assert.equal(runs, 1);
  net.setScutilRunnerForTest(null);
});

test('显式配置的代理连接失败时不改直连；不带令牌的请求才允许回退直连', async () => {
  net.setScutilRunnerForTest(() => '');
  const transport = fakeTransport((_url, init) => init?.method === 'CONNECT' ? new Error('proxy refused') : { status: 200, body: '{}' });
  try {
    await assert.rejects(net.smartFetch('https://oauth.example.com/token', { method: 'POST', body: 'refresh_token=secret', proxyUrl: 'http://127.0.0.1:9', sensitive: true }), /proxy refused/);
    await assert.rejects(net.smartFetch('https://oauth.example.com/token', { proxyUrl: 'http://127.0.0.1:9' }), /proxy refused/);
    assert.equal(transport.calls.some(call => call.startsWith('https')), false);

    process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
    try {
      await assert.rejects(net.smartFetch('https://oauth.example.com/token', { method: 'POST', body: 'refresh_token=secret', sensitive: true }), /proxy refused/);
      assert.equal(transport.calls.some(call => call.startsWith('https')), false);
      const plain = await net.smartFetch('https://usage.example.com/api');
      assert.equal(plain.status, 200);
    } finally { delete process.env.HTTPS_PROXY; }
  } finally { transport.restore(); net.setScutilRunnerForTest(null); }
});

test('响应流出错时请求失败，不会挂起或抛未捕获异常', async () => {
  net.setScutilRunnerForTest(() => '');
  const originals = { https: https.request };
  https.request = ((_target: any, _init: any, callback: (res: any) => void) => {
    const req = new EventEmitter() as any;
    req.setTimeout = () => req; req.write = () => {}; req.destroy = () => {};
    req.end = () => setImmediate(() => { const res = new EventEmitter() as any; res.statusCode = 200; callback(res); res.emit('error', new Error('connection reset')); });
    return req;
  }) as never;
  try { await assert.rejects(net.smartFetch('https://usage.example.com/api'), /connection reset/); }
  finally { https.request = originals.https; net.setScutilRunnerForTest(null); }
});

test('Codex 令牌过期：只提示，不请求刷新，auth.json 不变', async () => {
  const dir = mkdtempSync(join(root, 'codex-'));
  const authPath = join(dir, 'auth.json');
  const original = JSON.stringify({ tokens: { access_token: expired(), refresh_token: 'rt-codex', account_id: 'a' } });
  writeFileSync(authPath, original);
  const transport = fakeTransport(() => ({ status: 401, body: '{}' }));
  try {
    const report = await source('codex-multi').fetch({ providerId: 'codex', authPath } as never) as any;
    assert.equal(report.status, 'error');
    assert.match(report.error, /过期/);
    assert.equal(transport.calls.some(call => call.includes('auth.openai.com')), false);
    assert.equal(readFileSync(authPath, 'utf8'), original);
  } finally { transport.restore(); }
});

test('Codex 返回 401：不刷新令牌，auth.json 不变', async () => {
  const dir = mkdtempSync(join(root, 'codex-'));
  const authPath = join(dir, 'auth.json');
  const original = JSON.stringify({ tokens: { access_token: jwt(Math.floor(Date.now() / 1000) + 3600), refresh_token: 'rt-codex', account_id: 'a' } });
  writeFileSync(authPath, original);
  const transport = fakeTransport(() => ({ status: 401, body: '{}' }));
  try {
    await source('codex-multi').fetch({ providerId: 'codex', authPath } as never);
    assert.equal(transport.calls.some(call => call.includes('auth.openai.com')), false);
    assert.equal(readFileSync(authPath, 'utf8'), original);
  } finally { transport.restore(); }
});

test('Antigravity 额外账号经 agy-paseo 使用官方窗口，裸 agy 会被换成包装脚本', async () => {
  const dir = mkdtempSync(join(root, 'agy-'));
  const bin = join(dir, 'agy-paseo');
  writeFileSync(bin, `#!/bin/sh
printf '%s\\n' '{"status":"SUCCESS","command":{"name":"usage","data":{"groups":[{"name":"Gemini models","buckets":[{"id":"gemini-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.06,"reset_time":"2026-12-03T07:15:00Z"},{"id":"gemini-5h","name":"5h","window":"5h","remaining_fraction":0.98,"reset_time":"2026-11-27T05:15:00Z"}]},{"name":"Claude and GPT models","buckets":[{"id":"gpt-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":1,"reset_time":"2026-12-03T07:15:00Z"}]}]}}}'
`);
  chmodSync(bin, 0o755);
  const report = await source('antigravity-multi').fetch({
    providerId: 'antigravity-cy517',
    command: [bin],
    homeDir: dir,
  } as never) as any;
  assert.equal(report.status, 'available');
  assert.equal(report.planLabel, undefined);
  assert.equal(report.details, undefined);
  assert.deepEqual(report.windows.map((window: { label: string }) => window.label), [
    'Gemini · Weekly',
    'Gemini · 5h',
    'Claude and GPT · Weekly',
  ]);
});

test('Qoder 子进程立即退出：返回错误，写入已关闭的 stdin 不会抛未捕获异常', async () => {
  const bin = join(mkdtempSync(join(root, 'qoder-')), 'qodercli');
  writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  chmodSync(bin, 0o755);
  const report = await source('qoder').fetch({ providerId: 'qoder', command: [bin] } as never) as any;
  assert.equal(report.status, 'error');
  await new Promise(resolve => setTimeout(resolve, 100));
});

test('stopUsageChildren：模块停止时结束进行中的子进程', async () => {
  const bin = join(mkdtempSync(join(root, 'qoder-')), 'qodercli');
  writeFileSync(bin, '#!/bin/sh\nexec sleep 30\n');
  chmodSync(bin, 0o755);
  const started = Date.now();
  const pending = source('qoder').fetch({ providerId: 'qoder', command: [bin] } as never) as Promise<any>;
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(usage.runningUsageChildren(), 1);
  usage.stopUsageChildren();
  const report = await pending;
  assert.equal(report.status, 'error');
  assert.ok(Date.now() - started < 5_000);
  assert.equal(usage.runningUsageChildren(), 0);
});

test('额度来源 ID 不与 Paseo 内置插件重名：重名会让整个开发自动化插件加载失败', () => {
  // Paseo 0.17.1 内置插件注册的额度来源 ID（builtin-plugins/*/index.server.ts 与 antigravity-provider、muse-provider）。
  const builtin = ['antigravity', 'claude', 'codex', 'copilot', 'cursor', 'grok', 'kimi', 'minimax', 'muse', 'opencode-go', 'openrouter-host', 'zai'];
  const ours = usage.createUsageSources().map(item => item.id);
  assert.deepEqual(ours.filter(id => builtin.includes(id)), []);
  assert.ok(ours.includes('antigravity-multi'));
});
