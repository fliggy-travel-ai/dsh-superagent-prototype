import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hashAccountKey, type UsageReport, type UsageSourceRegistration } from '@getpaseo/plugin/server/usage';
import { BrowserBridge } from '../server/browser-bridge.ts';
import { BrowserUsageStore, formatRelativeTime, registerBrowserUsage, toUsageReport } from '../server/browser-usage.ts';

async function randomPort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('port');
  const port = address.port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

const origin = `chrome-extension://${'a'.repeat(32)}`;

// 第 2.3 节 Paseo 前端 sanitizeUsageEntry1664 的绝对时间过滤规则
const ABSOLUTE_TIME_PATTERNS = [
  /\b\d{1,2}:\d{2}\b/,
  /\d{1,2}\s*月\s*\d{1,2}\s*日/,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b(?:UTC|GMT|EST|EDT|CST|PDT|PST)\b/i,
  /\b(?:Asia|America|Europe)\/[A-Za-z_]+/,
];

function assertNoAbsoluteTime(report: UsageReport) {
  if (report.status === 'available') {
    for (const detail of report.details ?? []) {
      for (const pattern of ABSOLUTE_TIME_PATTERNS) {
        assert.equal(pattern.test(detail.label), false, `detail.label 匹配绝对时间: ${detail.label}`);
        assert.equal(pattern.test(detail.value), false, `detail.value 匹配绝对时间: ${detail.value}`);
      }
    }
  } else if (report.status === 'unavailable' && report.problem.kind === 'no_quota') {
    for (const pattern of ABSOLUTE_TIME_PATTERNS) {
      assert.equal(pattern.test(report.problem.detail), false, `problem.detail 匹配绝对时间: ${report.problem.detail}`);
    }
  } else if (report.status === 'error') {
    for (const pattern of ABSOLUTE_TIME_PATTERNS) {
      assert.equal(pattern.test(report.error), false, `error 匹配绝对时间: ${report.error}`);
    }
  }
}

test('多环境 discover：key 用 hashAccountKey(instanceId)，同名环境加 key 前 4 位后缀，session scope 返回空数组', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-usage-discover-'));
  let now = Date.parse('2026-11-08T12:00:00.000Z');
  let registered: UsageSourceRegistration | null = null;
  try {
    const store = registerBrowserUsage(
      { registerUsageSource(source) { registered = source; } },
      async () => ({ setUsageRoute() {}, snapshot: () => ({ settings: { enabled: true, port: 17373 } }) } as unknown as BrowserBridge),
      dir,
      () => now,
    );
    assert.ok(registered);
    const source = registered as UsageSourceRegistration;

    await store.record({
      instanceId: 'env-alpha',
      instanceName: '独立环境',
      status: 'ok',
      observedAt: '2026-11-08T11:59:00.000Z',
      fiveHour: { usedPct: 25, resetsAt: '2026-11-08T16:00:00.000Z', observedAt: '2026-11-08T11:59:00.000Z' },
      weekly: { usedPct: 40, resetsAt: '2026-11-14T00:00:00.000Z', observedAt: '2026-11-08T11:59:00.000Z' },
    }, now);
    await store.record({
      instanceId: 'env-dup-1',
      instanceName: '同名环境',
      status: 'pending',
      observedAt: '2026-11-08T11:59:00.000Z',
      fiveHour: null,
      weekly: null,
    }, now);
    await store.record({
      instanceId: 'env-dup-2',
      instanceName: '同名环境',
      status: 'pending',
      observedAt: '2026-11-08T11:59:00.000Z',
      fiveHour: null,
      weekly: null,
    }, now);

    assert.deepEqual(await source.discover({ kind: 'session', provider: 'claude', env: {} }), []);

    const accounts = await source.discover({ kind: 'global' });
    const keyAlpha = hashAccountKey('env-alpha');
    const keyDup1 = hashAccountKey('env-dup-1');
    const keyDup2 = hashAccountKey('env-dup-2');
    assert.deepEqual(accounts, [
      { key: keyAlpha, label: '独立环境', input: { instanceId: 'env-alpha' } },
      { key: keyDup1, label: `同名环境 · ${keyDup1.slice(0, 4)}`, input: { instanceId: 'env-dup-1' } },
      { key: keyDup2, label: `同名环境 · ${keyDup2.slice(0, 4)}`, input: { instanceId: 'env-dup-2' } },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toUsageReport 覆盖第 6.3 节全部状态行、重置时间已过提示与相对时间格式，且不含任何绝对时间', () => {
  const now = Date.parse('2026-11-08T14:00:00.000Z');
  const observedAt = '2026-11-08T11:45:00.000Z'; // 2 小时 15 分钟前
  const futureReset = '2026-11-08T16:50:00.000Z';
  const weeklyReset = '2026-11-14T00:00:00.000Z';

  assert.equal(formatRelativeTime(now - 20_000, now), '刚刚');
  assert.equal(formatRelativeTime(now - 15 * 60_000, now), '15 分钟前');
  assert.equal(formatRelativeTime(Date.parse(observedAt), now), '2 小时 15 分钟前');
  assert.equal(formatRelativeTime(now - (2 * 24 + 5) * 60 * 60_000, now), '2 天 5 小时前');

  const baseWindows = {
    fiveHour: { usedPct: 59, resetsAt: futureReset, observedAt },
    weekly: { usedPct: 46, resetsAt: weeklyReset, observedAt },
  };

  // 1. instanceId 不在存储中
  const missing = toUsageReport(null, now, true);
  assert.deepEqual(missing, { status: 'unavailable', problem: { kind: 'no_quota', detail: '该浏览器环境已长时间未连接' } });
  assertNoAbsoluteTime(missing);

  // 2. 通道已关闭，有数据
  const channelClosed = toUsageReport({
    instanceId: 'env-1',
    instanceName: '环境 1',
    lastPostAt: now - 10_000,
    status: 'ok',
    ...baseWindows,
  }, now, false);
  assert.equal(channelClosed.status, 'available');
  assert.equal(channelClosed.windows[0].usedPct, 59);
  assert.equal(channelClosed.windows[0].tone, 'default');
  assert.deepEqual(channelClosed.details, [
    { id: 'state', label: '状态', value: '开发自动化插件的浏览器通道已关闭，无法检测剩余额度，只展示上一次同步的额度', tone: 'warning' },
    { id: 'synced', label: '上一次同步', value: '2 小时 15 分钟前' },
  ]);
  assertNoAbsoluteTime(channelClosed);

  // 3. 不在线，有数据
  const offlineWithData = toUsageReport({
    instanceId: 'env-1',
    instanceName: '环境 1',
    lastPostAt: now - 200_000,
    status: 'ok',
    ...baseWindows,
  }, now, true);
  assert.equal(offlineWithData.status, 'available');
  assert.equal(offlineWithData.windows[0].usedPct, 59);
  assert.equal(offlineWithData.windows[0].tone, 'default');
  assert.deepEqual(offlineWithData.details, [
    { id: 'state', label: '状态', value: '未打开浏览器，无法检测剩余额度，只展示上一次同步的额度', tone: 'warning' },
    { id: 'synced', label: '上一次同步', value: '2 小时 15 分钟前' },
  ]);
  assertNoAbsoluteTime(offlineWithData);

  // 4. 不在线，无数据
  const offlineNoData = toUsageReport({
    instanceId: 'env-1',
    instanceName: '环境 1',
    lastPostAt: now - 200_000,
    status: 'pending',
    fiveHour: null,
    weekly: null,
  }, now, true);
  assert.deepEqual(offlineNoData, {
    status: 'unavailable',
    problem: { kind: 'no_quota', detail: '未打开浏览器，无法检测剩余额度，还没有同步过额度' },
  });
  assertNoAbsoluteTime(offlineNoData);

  // 5. 在线，ok（带两个窗口同步时间相差超过 10 分钟的情况）
  const onlineOk = toUsageReport({
    instanceId: 'env-1',
    instanceName: '环境 1',
    lastPostAt: now - 30_000,
    status: 'ok',
    fiveHour: { usedPct: 75, resetsAt: futureReset, observedAt: new Date(now - 60_000).toISOString() },
    weekly: { usedPct: 46, resetsAt: weeklyReset, observedAt },
  }, now, true);
  assert.equal(onlineOk.status, 'available');
  assert.equal(onlineOk.windows[0].tone, 'warning');
  assert.equal(onlineOk.windows[1].tone, 'ok');
  assert.deepEqual(onlineOk.details, [
    { id: 'synced', label: '同步时间', value: '1 分钟前' },
    { id: 'weekly-synced', label: '每周窗口同步时间', value: '2 小时 15 分钟前' },
  ]);
  assertNoAbsoluteTime(onlineOk);

  // 6. 在线，signed_out，有数据
  const signedOutWithData = toUsageReport({
    instanceId: 'env-1',
    instanceName: '环境 1',
    lastPostAt: now - 30_000,
    status: 'signed_out',
    ...baseWindows,
  }, now, true);
  assert.equal(signedOutWithData.status, 'available');
  assert.equal(signedOutWithData.windows[0].tone, 'default');
  assert.deepEqual(signedOutWithData.details, [
    { id: 'state', label: '状态', value: '该浏览器环境未登录 claude.ai，只展示上一次同步的额度', tone: 'warning' },
    { id: 'synced', label: '上一次同步', value: '2 小时 15 分钟前' },
  ]);
  assertNoAbsoluteTime(signedOutWithData);

  // 7. 在线，signed_out，无数据
  const signedOutNoData = toUsageReport({
    instanceId: 'env-1',
    instanceName: '环境 1',
    lastPostAt: now - 30_000,
    status: 'signed_out',
    fiveHour: null,
    weekly: null,
  }, now, true);
  assert.deepEqual(signedOutNoData, {
    status: 'unavailable',
    problem: { kind: 'no_quota', detail: '该浏览器环境未登录 claude.ai' },
  });
  assertNoAbsoluteTime(signedOutNoData);

  // 8 & 9. 在线，failed（有数据与无数据，遍历全部 5 种原因）
  const expectedReasons = [
    ['no_window', '没有打开的浏览器窗口'],
    ['parse', '页面格式无法识别'],
    ['timeout', '页面加载超时'],
    ['challenge', '需要完成安全验证'],
    ['tab_closed', '读取页面被关闭'],
  ] as const;
  for (const [reason, label] of expectedReasons) {
    const failedWithData = toUsageReport({
      instanceId: 'env-1',
      instanceName: '环境 1',
      lastPostAt: now - 20_000,
      status: 'failed',
      reason,
      ...baseWindows,
    }, now, true);
    assert.equal(failedWithData.status, 'available');
    assert.equal(failedWithData.details?.[0].value, `额度读取失败（${label}），只展示上一次同步的额度`);
    assertNoAbsoluteTime(failedWithData);

    const failedNoData = toUsageReport({
      instanceId: 'env-1',
      instanceName: '环境 1',
      lastPostAt: now - 20_000,
      status: 'failed',
      reason,
      fiveHour: null,
      weekly: null,
    }, now, true);
    assert.deepEqual(failedNoData, { status: 'error', error: `额度读取失败（${label}）` });
    assertNoAbsoluteTime(failedNoData);
  }

  // 10. 在线，pending
  const onlinePending = toUsageReport({
    instanceId: 'env-1',
    instanceName: '环境 1',
    lastPostAt: now - 10_000,
    status: 'pending',
    fiveHour: null,
    weekly: null,
  }, now, true);
  assert.deepEqual(onlinePending, {
    status: 'unavailable',
    problem: { kind: 'no_quota', detail: '正在等待第一次读取额度' },
  });
  assertNoAbsoluteTime(onlinePending);

  // 显示上一次数据且某个窗口的重置时间已过时：数字保留，状态行末尾追加说明
  const pastResetReport = toUsageReport({
    instanceId: 'env-1',
    instanceName: '环境 1',
    lastPostAt: now - 300_000,
    status: 'ok',
    fiveHour: { usedPct: 59, resetsAt: '2026-11-08T11:50:00.000Z', observedAt },
    weekly: { usedPct: 46, resetsAt: weeklyReset, observedAt },
  }, now, true);
  assert.equal(pastResetReport.status, 'available');
  assert.equal(pastResetReport.windows[0].usedPct, 59);
  assert.equal(pastResetReport.windows[1].usedPct, 46);
  assert.equal(
    pastResetReport.details?.[0].value,
    '未打开浏览器，无法检测剩余额度，只展示上一次同步的额度；部分窗口已过重置时间，实际用量可能更低',
  );
  assertNoAbsoluteTime(pastResetReport);
});

test('窗口替换规则、0600 持久化、重启恢复与 3 天过期清理', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-usage-store-'));
  let now = Date.parse('2026-11-08T12:00:00.000Z');
  try {
    const store = new BrowserUsageStore(dir, () => now);
    await store.load();

    // 未来时间的 observedAt 被截断为接收时间 now
    await store.record({
      instanceId: 'env-1',
      instanceName: '主环境',
      status: 'ok',
      observedAt: '2026-11-08T13:00:00.000Z',
      fiveHour: { usedPct: 50, resetsAt: '2026-11-08T16:00:00.000Z', observedAt: '2026-11-08T13:00:00.000Z' },
      weekly: { usedPct: 30, resetsAt: '2026-11-14T00:00:00.000Z', observedAt: '2026-11-08T12:00:00.000Z' },
    }, now);

    const first = await store.get('env-1', now);
    assert.equal(first?.fiveHour?.observedAt, '2026-11-08T12:00:00.000Z');
    assert.equal((await stat(join(dir, 'browser-usage.json'))).mode & 0o777, 0o600);

    // null 窗口不覆盖旧值；更旧的 observedAt 不覆盖新值
    now += 60_000;
    await store.record({
      instanceId: 'env-1',
      instanceName: '主环境',
      status: 'failed',
      reason: 'timeout',
      observedAt: new Date(now).toISOString(),
      fiveHour: null,
      weekly: { usedPct: 10, resetsAt: '2026-11-14T00:00:00.000Z', observedAt: '2026-11-08T11:00:00.000Z' },
    }, now);

    const second = await store.get('env-1', now);
    assert.equal(second?.fiveHour?.usedPct, 50);
    assert.equal(second?.weekly?.usedPct, 30);
    assert.equal(second?.status, 'failed');
    assert.equal(second?.reason, 'timeout');

    // 重建存储实例后数据仍然存在
    const restored = new BrowserUsageStore(dir, () => now);
    await restored.load();
    const fromDisk = await restored.get('env-1', now);
    assert.equal(fromDisk?.fiveHour?.usedPct, 50);
    assert.equal(fromDisk?.weekly?.usedPct, 30);

    // 超过 3 天未收到 POST 的记录在读取时删除
    const afterThreeDays = now + 3 * 24 * 60 * 60 * 1000 + 1;
    assert.equal(await restored.get('env-1', afterThreeDays), null);
    assert.deepEqual(await restored.discover(afterThreeDays), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('真实 BrowserBridge /usage 路由：OPTIONS 预检、鉴权、参数校验、写入存储且不影响 /sync', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-usage-bridge-'));
  const bridge = new BrowserBridge(dir, async () => null);
  let registered: UsageSourceRegistration | null = null;
  try {
    await bridge.start();
    await bridge.configure({ enabled: true, port: await randomPort() });
    const pairing = await bridge.pairing();
    const usageUrl = pairing.url.replace(/\/sync$/, '/usage');

    registerBrowserUsage(
      { registerUsageSource(source) { registered = source; } },
      async () => bridge,
      dir,
    );
    assert.ok(registered);
    const source = registered as UsageSourceRegistration;

    // OPTIONS /usage 预检通过
    const preflight = await fetch(usageUrl, { method: 'OPTIONS', headers: { origin } });
    assert.equal(preflight.status, 204);

    // 无令牌返回 401
    const unauthorized = await fetch(usageUrl, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(unauthorized.status, 401);

    // 非法比例 150 返回 400
    const nowIso = new Date().toISOString();
    const invalidPct = await fetch(usageUrl, {
      method: 'POST',
      headers: { origin, authorization: `Bearer ${pairing.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        instanceId: 'env-29',
        instanceName: 'SunBrowser 29',
        status: 'ok',
        observedAt: nowIso,
        fiveHour: { usedPct: 150, resetsAt: null, observedAt: nowIso },
        weekly: null,
      }),
    });
    assert.equal(invalidPct.status, 400);

    // 合法 /usage 请求返回 204 并进入存储
    const validRes = await fetch(usageUrl, {
      method: 'POST',
      headers: { origin, authorization: `Bearer ${pairing.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        instanceId: 'env-29',
        instanceName: 'SunBrowser 29',
        status: 'ok',
        observedAt: nowIso,
        fiveHour: { usedPct: 59, resetsAt: '2026-11-08T11:50:00.000Z', observedAt: nowIso },
        weekly: { usedPct: 46, resetsAt: '2026-11-14T00:00:00.000Z', observedAt: nowIso },
      }),
    });
    assert.equal(validRes.status, 204);

    const accounts = await source.discover({ kind: 'global' });
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].key, hashAccountKey('env-29'));
    assert.equal(accounts[0].label, 'SunBrowser 29');

    const report = await source.fetch({ instanceId: 'env-29' });
    assert.equal(report.status, 'available');
    assert.equal(report.windows[0].usedPct, 59);
    assert.equal(report.windows[1].usedPct, 46);

    // /sync 路由不受影响
    const syncRes = await fetch(pairing.url, {
      method: 'POST',
      headers: { origin, authorization: `Bearer ${pairing.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        instanceId: 'env-29',
        instanceName: 'SunBrowser 29',
        sessions: [{ sessionId: 'abc', title: '测试会话', url: 'https://claude.ai/code/session_abc', tabCount: 1 }],
      }),
    });
    assert.equal(syncRes.status, 200);
  } finally {
    await bridge.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
