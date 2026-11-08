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

test('AdsPower 本地 API 环境名称解析：按序号/user_id 查询并缓存 10 分钟、单活跃环境自动识别、多环境或无名称时回退、支持可选 API Key 与 3 秒超时', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-usage-adspower-'));
  let now = Date.parse('2026-11-08T12:00:00.000Z');
  let registered: UsageSourceRegistration | null = null;
  const apiCalls: Array<{ url: string; auth?: string }> = [];
  let activeList: Array<{ user_id?: string; serial_number?: string; name?: string }> = [
    { user_id: 'k129xyz', serial_number: '29' },
  ];
  let userProfiles: Record<string, { user_id: string; serial_number?: string; name?: string }> = {
    '29': { user_id: 'k129xyz', serial_number: '29', name: 'Claude 29 号环境' },
    'k129xyz': { user_id: 'k129xyz', serial_number: '29', name: 'Claude 29 号环境' },
    '30': { user_id: 'k130abc', serial_number: '30', name: '' },
    'k1onlyid': { user_id: 'k1onlyid', serial_number: '', name: '' },
  };
  let apiShouldFail = false;

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    apiCalls.push({ url, auth: headers.authorization });
    if (apiShouldFail) throw new Error('connect ECONNREFUSED');
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v1/browser/local-active') {
      return {
        ok: true,
        async json() {
          return { code: 0, msg: 'success', data: { list: activeList } };
        },
      } as Response;
    }
    if (parsed.pathname === '/api/v1/user/list') {
      const serial = parsed.searchParams.get('serial_number');
      const userId = parsed.searchParams.get('user_id');
      const hit = (serial && userProfiles[serial]) || (userId && userProfiles[userId]) || null;
      return {
        ok: true,
        async json() {
          return { code: 0, msg: 'success', data: { list: hit ? [hit] : [] } };
        },
      } as Response;
    }
    return { ok: false, async json() { return { code: -1 }; } } as Response;
  };

  try {
    // 1. 未配置 API Key、仅 1 个扩展上报且未填序号（默认“未命名浏览器环境”）、本机恰好 1 个活跃环境 -> 自动查 local-active + user/list 解析出 AdsPower 名称
    const store = registerBrowserUsage(
      { registerUsageSource(source) { registered = source; } },
      async () => ({ setUsageRoute() {}, snapshot: () => ({ settings: { enabled: true, port: 17373 } }) } as unknown as BrowserBridge),
      dir,
      () => now,
      { adspowerApiUrl: 'http://127.0.0.1:50325', fetchFn: fakeFetch },
    );
    assert.ok(registered);
    const source = registered as UsageSourceRegistration;

    await store.record({
      instanceId: 'env-29',
      instanceName: '未命名浏览器环境',
      status: 'ok',
      observedAt: '2026-11-08T11:59:00.000Z',
      fiveHour: { usedPct: 25, resetsAt: '2026-11-08T16:00:00.000Z', observedAt: '2026-11-08T11:59:00.000Z' },
      weekly: { usedPct: 40, resetsAt: '2026-11-14T00:00:00.000Z', observedAt: '2026-11-08T11:59:00.000Z' },
    }, now);

    assert.equal(apiCalls.length, 2);
    assert.equal(apiCalls[0]!.url, 'http://127.0.0.1:50325/api/v1/browser/local-active');
    assert.equal(apiCalls[0]!.auth, undefined);
    assert.equal(apiCalls[1]!.url, 'http://127.0.0.1:50325/api/v1/user/list?user_id=k129xyz');
    const rec29 = await store.get('env-29', now);
    assert.equal(rec29?.displayName, 'Claude 29 号环境');
    assert.equal(rec29?.labelSource, 'adspower_name');
    assert.equal(rec29?.labelSourceText, 'AdsPower 名称');
    assert.deepEqual(await source.discover({ kind: 'global' }), [
      { key: hashAccountKey('env-29'), label: 'Claude 29 号环境', input: { instanceId: 'env-29' } },
    ]);

    // 2. 10 分钟内重复上报 /usage：命中缓存且未满 10 分钟，不发起任何 AdsPower API 请求
    now += 60_000;
    await store.record({
      instanceId: 'env-29',
      instanceName: '未命名浏览器环境',
      status: 'ok',
      observedAt: new Date(now).toISOString(),
      fiveHour: { usedPct: 28, resetsAt: '2026-11-08T16:00:00.000Z', observedAt: new Date(now).toISOString() },
      weekly: { usedPct: 40, resetsAt: '2026-11-14T00:00:00.000Z', observedAt: new Date(now).toISOString() },
    }, now);
    assert.equal(apiCalls.length, 2);

    // 3. 第 2 个扩展开始上报：env-29 未配置序号，不再使用单环境自动识别结果，直接回退为 instanceName；而显式配置了序号 30（AdsPower name 为空）的环境回退显示序号 "30"（labelSource: serial_number）
    await store.record({
      instanceId: 'env-30',
      instanceName: '未命名浏览器环境',
      adspowerProfile: '30',
      status: 'ok',
      observedAt: new Date(now).toISOString(),
      fiveHour: { usedPct: 10, resetsAt: '2026-11-08T16:00:00.000Z', observedAt: new Date(now).toISOString() },
      weekly: { usedPct: 20, resetsAt: '2026-11-14T00:00:00.000Z', observedAt: new Date(now).toISOString() },
    }, now);
    const rec29AfterMulti = await store.get('env-29', now);
    assert.equal(rec29AfterMulti?.displayName, '未命名浏览器环境');
    assert.equal(rec29AfterMulti?.labelSource, 'instance_name');
    const rec30 = await store.get('env-30', now);
    assert.equal(rec30?.displayName, '30');
    assert.equal(rec30?.labelSource, 'serial_number');
    assert.equal(rec30?.labelSourceText, 'AdsPower 序号');

    // 4. 给 env-29 填上序号 29：序号变化触发查询，命中 user_id 缓存（< 10 分钟）直接拿到 "Claude 29 号环境"，不额外发 HTTP 请求
    const callsBeforeBind29 = apiCalls.length;
    await store.record({
      instanceId: 'env-29',
      instanceName: '未命名浏览器环境',
      adspowerProfile: '29',
      status: 'ok',
      observedAt: new Date(now).toISOString(),
      fiveHour: { usedPct: 28, resetsAt: '2026-11-08T16:00:00.000Z', observedAt: new Date(now).toISOString() },
      weekly: { usedPct: 40, resetsAt: '2026-11-14T00:00:00.000Z', observedAt: new Date(now).toISOString() },
    }, now);
    assert.equal(apiCalls.length, callsBeforeBind29);
    assert.equal((await store.get('env-29', now))?.displayName, 'Claude 29 号环境');
    assert.equal((await store.get('env-29', now))?.labelSource, 'adspower_name');

    // 5. 满 10 分钟后再次上报，且配置了 adspowerApiKey：重新请求 /api/v1/user/list 并携带 Authorization: Bearer
    now += 10 * 60_000;
    const authedStore = new BrowserUsageStore(dir, () => now, {
      adspowerApiUrl: 'http://127.0.0.1:50325',
      adspowerApiKey: 'secret-adspower-key',
      fetchFn: fakeFetch,
    });
    await authedStore.load(now);
    userProfiles['29'] = { user_id: 'k129xyz', serial_number: '29', name: 'Claude 29 号改名后' };
    await authedStore.record({
      instanceId: 'env-29',
      instanceName: '未命名浏览器环境',
      adspowerProfile: '29',
      status: 'ok',
      observedAt: new Date(now).toISOString(),
      fiveHour: { usedPct: 30, resetsAt: '2026-11-08T16:00:00.000Z', observedAt: new Date(now).toISOString() },
      weekly: { usedPct: 42, resetsAt: '2026-11-14T00:00:00.000Z', observedAt: new Date(now).toISOString() },
    }, now);
    assert.equal(apiCalls.at(-1)?.url, 'http://127.0.0.1:50325/api/v1/user/list?serial_number=29');
    assert.equal(apiCalls.at(-1)?.auth, 'Bearer secret-adspower-key');
    assert.equal((await authedStore.get('env-29', now))?.displayName, 'Claude 29 号改名后');

    // 6. AdsPower API 失败时不影响额度上报：只填了 user_id 时回退显示 user_id（labelSource: user_id），既无序号也无 user_id 时回退显示 instanceName（labelSource: instance_name），已有解析结果的保留上次名称
    apiShouldFail = true;
    await authedStore.record({
      instanceId: 'env-userid',
      instanceName: '未命名浏览器环境',
      adspowerProfile: 'k1onlyid',
      status: 'ok',
      observedAt: new Date(now).toISOString(),
      fiveHour: { usedPct: 15, resetsAt: '2026-11-08T16:00:00.000Z', observedAt: new Date(now).toISOString() },
      weekly: { usedPct: 25, resetsAt: '2026-11-14T00:00:00.000Z', observedAt: new Date(now).toISOString() },
    }, now);
    const recUserId = await authedStore.get('env-userid', now);
    assert.equal(recUserId?.displayName, 'k1onlyid');
    assert.equal(recUserId?.labelSource, 'user_id');
    assert.equal(recUserId?.labelSourceText, 'AdsPower user_id');
    assert.equal(recUserId?.fiveHour?.usedPct, 15);

    // 同名环境在 discover 中自动追加 4 位哈希后缀，离线重载后仍保留持久化的 AdsPower 名称
    await authedStore.record({
      instanceId: 'env-dup-1',
      instanceName: '同名自定义环境',
      status: 'pending',
      observedAt: new Date(now).toISOString(),
      fiveHour: null,
      weekly: null,
    }, now);
    await authedStore.record({
      instanceId: 'env-dup-2',
      instanceName: '同名自定义环境',
      status: 'pending',
      observedAt: new Date(now).toISOString(),
      fiveHour: null,
      weekly: null,
    }, now);

    now += 15 * 60_000;
    const reloaded = new BrowserUsageStore(dir, () => now, { fetchFn: fakeFetch });
    await reloaded.load(now);
    const discovered = await reloaded.discover(now);
    const keyDup1 = hashAccountKey('env-dup-1');
    const keyDup2 = hashAccountKey('env-dup-2');
    assert.deepEqual(discovered, [
      { key: hashAccountKey('env-29'), label: 'Claude 29 号改名后', input: { instanceId: 'env-29' } },
      { key: hashAccountKey('env-30'), label: '30', input: { instanceId: 'env-30' } },
      { key: hashAccountKey('env-userid'), label: 'k1onlyid', input: { instanceId: 'env-userid' } },
      { key: keyDup1, label: `同名自定义环境 · ${keyDup1.slice(0, 4)}`, input: { instanceId: 'env-dup-1' } },
      { key: keyDup2, label: `同名自定义环境 · ${keyDup2.slice(0, 4)}`, input: { instanceId: 'env-dup-2' } },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AdsPower 本地 API 边界条件：local-active 返回多个活跃环境时不猜测，请求超时中止并按顺序回退且不影响额度写入', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-usage-adspower-edge-'));
  const now = Date.parse('2026-11-08T12:00:00.000Z');
  try {
    // 1. 本机有 2 个活跃环境时，即使只有 1 个扩展上报，也不猜测，回退显示 instanceName
    const multiActiveStore = new BrowserUsageStore(dir, () => now, {
      fetchFn: async () => ({
        ok: true,
        async json() {
          return {
            code: 0,
            data: {
              list: [
                { user_id: 'k1', serial_number: '29', name: '环境 29' },
                { user_id: 'k2', serial_number: '30', name: '环境 30' },
              ],
            },
          };
        },
      } as Response),
    });
    await multiActiveStore.record({
      instanceId: 'env-single-ext',
      instanceName: '未命名浏览器环境',
      status: 'ok',
      observedAt: '2026-11-08T11:59:00.000Z',
      fiveHour: { usedPct: 33, resetsAt: '2026-11-08T16:00:00.000Z', observedAt: '2026-11-08T11:59:00.000Z' },
      weekly: { usedPct: 44, resetsAt: '2026-11-14T00:00:00.000Z', observedAt: '2026-11-08T11:59:00.000Z' },
    }, now);
    const recMulti = await multiActiveStore.get('env-single-ext', now);
    assert.equal(recMulti?.displayName, '未命名浏览器环境');
    assert.equal(recMulti?.labelSource, 'instance_name');
    assert.equal(recMulti?.fiveHour?.usedPct, 33);

    // 2. AdsPower API 响应超时时由 AbortSignal 中止，回退显示序号且额度正常保存
    let aborted = false;
    const timeoutStore = new BrowserUsageStore(dir, () => now, {
      adspowerTimeoutMs: 30,
      fetchFn: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('Aborted'));
        });
      }),
    });
    await timeoutStore.record({
      instanceId: 'env-timeout',
      instanceName: '29',
      status: 'ok',
      observedAt: '2026-11-08T11:59:00.000Z',
      fiveHour: { usedPct: 50, resetsAt: '2026-11-08T16:00:00.000Z', observedAt: '2026-11-08T11:59:00.000Z' },
      weekly: { usedPct: 60, resetsAt: '2026-11-14T00:00:00.000Z', observedAt: '2026-11-08T11:59:00.000Z' },
    }, now);
    assert.equal(aborted, true);
    const recTimeout = await timeoutStore.get('env-timeout', now);
    assert.equal(recTimeout?.displayName, '29');
    assert.equal(recTimeout?.labelSource, 'serial_number');
    assert.equal(recTimeout?.fiveHour?.usedPct, 50);
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

  // 5b. 在线，ok，5 小时窗口未开始（0%、resetsAt 为 null）且每周窗口有重置时间
  const notStartedFiveHour = toUsageReport({
    instanceId: 'env-1',
    instanceName: '环境 1',
    lastPostAt: now - 30_000,
    status: 'ok',
    fiveHour: { usedPct: 0, resetsAt: null, observedAt },
    weekly: { usedPct: 46, resetsAt: weeklyReset, observedAt },
  }, now, true);
  assert.equal(notStartedFiveHour.status, 'available');
  assert.equal(notStartedFiveHour.windows[0].usedPct, 0);
  assert.equal(notStartedFiveHour.windows[0].remainingPct, 100);
  assert.equal(notStartedFiveHour.windows[0].resetsAt, null);
  assert.equal(notStartedFiveHour.windows[0].tone, 'ok');
  assert.equal(notStartedFiveHour.windows[1].usedPct, 46);
  assert.equal(notStartedFiveHour.windows[1].resetsAt, weeklyReset);
  assertNoAbsoluteTime(notStartedFiveHour);

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
