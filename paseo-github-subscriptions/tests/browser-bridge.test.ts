import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserBridge } from '../server/browser-bridge.ts';

async function port() { const server = createServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('port'); const n = address.port; await new Promise<void>(r => server.close(() => r())); return n; }
const origin = `chrome-extension://${'a'.repeat(32)}`;
const session = (id: string, title = '同名') => ({ sessionId: id, title, url: `https://claude.ai/code/session_${id}`, tabCount: 1 });

test('网页权限回执按环境及预约去重、保持终态并在重启后保留', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-audit-'));
  const bridge = new BrowserBridge(directory, async () => null);
  let restored: BrowserBridge | undefined;
  try {
    await bridge.start(); await bridge.configure({ enabled: true, port: await port() });
    const pairing = await bridge.pairing();
    const approval = { sessionId: 'abc', reservationId: 'request-one', digest: 'a'.repeat(64), button: 'Allow once', at: new Date().toISOString(), status: 'reserved' };
    const post = (instanceId: string, approvals?: unknown[]) => fetch(pairing.url, { method: 'POST', headers: { origin, authorization: `Bearer ${pairing.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ instanceId, sessions: [session('abc')], ...(approvals ? { approvals } : {}) }) });
    assert.equal((await post('one')).status, 200);
    assert.equal((await post('one', [approval])).status, 200);
    assert.equal((await post('one', [{ ...approval, button: 'Allow', status: 'dismissed' }])).status, 200);
    assert.equal((await post('one', [{ ...approval, at: new Date(Date.now() + 1000).toISOString(), status: 'dismissed' }])).status, 200);
    assert.equal(bridge.snapshot().approvals?.[0].status, 'reserved');
    assert.equal((await post('one', [{ ...approval, status: 'dismissed', observedAt: new Date().toISOString() }])).status, 200);
    assert.equal((await post('one', [approval])).status, 200);
    assert.equal(bridge.snapshot().approvals?.length, 1);
    assert.equal(bridge.snapshot().approvals?.[0].status, 'dismissed');
    assert.equal((await post('two', [approval])).status, 200);
    assert.equal(bridge.snapshot().approvals?.length, 2);
    assert.equal((await post('one', [{ ...approval, status: 'approved' }])).status, 400);
    await bridge.stop();
    restored = new BrowserBridge(directory, async () => null); await restored.start();
    assert.equal(restored.snapshot().approvals?.length, 2);
  } finally { await bridge.stop(); await restored?.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('配对鉴权、严格输入、跨 profile 绑定、重命名及关闭', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-bridge-'));
  let title: string | null = 'Paseo 原名';
  const bridge = new BrowserBridge(dir, async id => id === 'agent' && title !== null ? { id, title } : null);
  try {
    await bridge.start(); assert.equal(bridge.snapshot().settings.enabled, false);
    await bridge.configure({ enabled: true, port: await port() });
    const pairing = await bridge.pairing();
    const post = (body: unknown, opts: { token?: string; origin?: string } = {}) => fetch(pairing.url, { method: 'POST', headers: { origin: opts.origin ?? origin, authorization: `Bearer ${opts.token ?? pairing.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await stat(join(dir, 'browser-token'))).mode & 0o777, 0o600);
    assert.equal((await post({ instanceId: 'p1', sessions: [] }, { token: 'bad' })).status, 401);
    assert.equal((await post({ instanceId: 'p1', sessions: [] }, { origin: 'https://example.com' })).status, 403);
    assert.equal((await post({ instanceId: 'p1', sessions: [], extra: 1 })).status, 400);
    assert.equal((await post({ instanceId: 'p1', instanceName: ' ', sessions: [] })).status, 400);
    assert.equal((await post({ instanceId: 'p1', instanceName: 'x'.repeat(121), sessions: [] })).status, 400);
    assert.equal((await post({ instanceId: 'p1', sessions: [{ ...session('abc'), url: 'https://other.test/code/session_abc' }] })).status, 400);
    assert.equal((await post({ instanceId: 'p1', sessions: [session('abc'), session('abc')] })).status, 400);
    assert.equal((await post({ instanceId: 'p1', sessions: [], extra: 'x'.repeat(70000) }).catch(() => null))?.status ?? 413, 413);
    assert.equal((await post({ instanceId: 'p1', instanceName: '同名环境', sessions: [session('abc')] })).status, 200);
    assert.equal((await post({ instanceId: 'p2', instanceName: '同名环境', sessions: [session('abc')] })).status, 200);
    assert.equal(bridge.snapshot().sessions.length, 2);
    assert.deepEqual(bridge.snapshot().sessions.map(s => s.instanceName), ['同名环境', '同名环境']);
    await assert.rejects(bridge.bind({ instanceId: 'p1', sessionId: 'abc', agentId: 'missing' }));
    await assert.rejects(bridge.bind({ instanceId: 'p3', sessionId: 'abc', agentId: 'agent' }));
    await bridge.bind({ instanceId: 'p1', sessionId: 'abc', agentId: 'agent' });
    title = 'Paseo 新名';
    const result = await (await post({ instanceId: 'p1', sessions: [session('abc')] })).json() as { sessions: { groupTitle: string }[] };
    assert.equal(result.sessions[0].groupTitle, 'Paseo 新名');
    assert.equal(bridge.snapshot().sessions.find(s => s.instanceId === 'p1')?.instanceName, '未命名浏览器环境');
    assert.equal(bridge.snapshot().sessions.find(s => s.instanceId === 'p2')?.groupTitle, '同名');
    assert.equal(JSON.stringify(bridge.snapshot()).includes(pairing.token), false);
    title = null;
    await post({ instanceId: 'p1', sessions: [session('abc', '')] });
    assert.equal(bridge.snapshot().sessions.find(s => s.instanceId === 'p1')?.groupTitle, '未命名会话');
    assert.equal(bridge.snapshot().sessions.find(s => s.instanceId === 'p1')?.agentId, null);
    assert.equal(bridge.snapshot().bindings.length, 0);
    await bridge.configure({ enabled: false, port: Number(new URL(pairing.url).port) });
    assert.equal(bridge.snapshot().connected, false);
    await assert.rejects(fetch(pairing.url)); await assert.rejects(bridge.pairing());
  } finally { await bridge.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('端口切换关闭旧监听，重启保留设置及配对令牌', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-restart-'));
  const first = new BrowserBridge(dir, async () => null);
  let second: BrowserBridge | undefined;
  try {
    await first.start(); const a = await port(); await first.configure({ enabled: true, port: a });
    const before = await first.pairing(); const b = await port();
    await first.configure({ enabled: true, port: b });
    await assert.rejects(fetch(before.url));
    assert.equal((await first.pairing()).token, before.token);
    await first.stop();
    second = new BrowserBridge(dir, async () => null); await second.start();
    assert.equal((await second.pairing()).url, `http://127.0.0.1:${b}/sync`);
    assert.equal((await second.pairing()).token, before.token);
  } finally { await first.stop(); await second?.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('启动时端口冲突可读取错误并通过 configure 恢复', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-conflict-'));
  const occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const address = occupied.address(); if (!address || typeof address === 'string') throw new Error('port');
  await writeFile(join(dir, 'browser-state.json'), JSON.stringify({ settings: { enabled: true, port: address.port }, bindings: [] }));
  const bridge = new BrowserBridge(dir, async () => null);
  try {
    await bridge.start();
    assert.equal(bridge.snapshot().error, '浏览器桥接端口不可用');
    assert.equal(bridge.snapshot().connected, false);
    await assert.rejects(bridge.pairing());
    const replacement = await port();
    const snapshot = await bridge.configure({ enabled: true, port: replacement });
    assert.equal(snapshot.error, null);
    assert.equal((await bridge.pairing()).url, `http://127.0.0.1:${replacement}/sync`);
  } finally { await bridge.stop(); await new Promise<void>(resolve => occupied.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});
