import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

/** 替换 http(s).request：记录调用，按处理函数返回响应。 */
function fakeTransport(handler: (url: URL, init: any, body: string) => { status: number; body: string } | Error) {
  const calls: string[] = [];
  const originals = { http: http.request, https: https.request };
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
        callback(res);
        res.emit('data', Buffer.from(result.body));
        res.emit('end');
      });
    };
    return req;
  }) as never;
  http.request = make('http');
  https.request = make('https');
  return { calls, restore() { http.request = originals.http; https.request = originals.https; } };
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

test('Cursor 刷新令牌：保存新的访问令牌和新的刷新令牌，原子写入、权限 0600、不留临时文件', async () => {
  const dir = mkdtempSync(join(root, 'cursor-'));
  const authPath = join(dir, 'auth.json');
  writeFileSync(authPath, JSON.stringify({ accessToken: expired(), refreshToken: 'rt-old', other: 'keep' }));
  const transport = fakeTransport(url => url.pathname === '/oauth/token'
    ? { status: 200, body: JSON.stringify({ access_token: 'at-new', refresh_token: 'rt-new' }) }
    : { status: 500, body: '{}' });
  try {
    await source('cursor-cli').fetch({ providerId: 'cursor', authPath } as never);
    const saved = JSON.parse(readFileSync(authPath, 'utf8'));
    assert.equal(saved.accessToken, 'at-new');
    assert.equal(saved.refreshToken, 'rt-new');
    assert.equal(saved.other, 'keep');
    assert.equal(statSync(authPath).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), ['auth.json']);
  } finally { transport.restore(); }
});

test('Antigravity 刷新令牌：原子写入、权限 0600、不留临时文件', async () => {
  const dir = mkdtempSync(join(root, 'agy-'));
  const authPath = join(dir, 'antigravity-oauth-token');
  writeFileSync(authPath, JSON.stringify({ client_id: 'cid', client_secret: 'csecret', token: { access_token: 'at-old', refresh_token: 'rt-old', expiry: new Date(Date.now() - 1000).toISOString() } }));
  const transport = fakeTransport(url => url.pathname === '/token'
    ? { status: 200, body: JSON.stringify({ access_token: 'at-new', expires_in: 3600 }) }
    : { status: 500, body: '{}' });
  try {
    await source('antigravity').fetch({ providerId: 'antigravity-x', authPath } as never);
    const saved = JSON.parse(readFileSync(authPath, 'utf8'));
    assert.equal(saved.token.access_token, 'at-new');
    assert.equal(saved.token.refresh_token, 'rt-old');
    assert.equal(statSync(authPath).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), ['antigravity-oauth-token']);
  } finally { transport.restore(); }
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
