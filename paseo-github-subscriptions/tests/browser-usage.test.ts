import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hashAccountKey, type UsageReport, type UsageSourceRegistration } from '@getpaseo/plugin/server/usage';
import { createControlStore } from '../client/control-store.ts';
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

test('AdsPower 本地 API 环境名称解析：默认 127.0.0.1:50325、批量查询缓存 10 分钟、单活跃环境自动识别、多环境回退并立即落盘、回退与保留上次名称', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-usage-adspower-'));
  let now = Date.parse('2026-11-08T12:00:00.000Z');
  let registered: UsageSourceRegistration | null = null;
  const apiCalls: Array<{ url: string; auth?: string }> = [];
  let activeList: Array<{ user_id?: string; serial_number?: string; name?: string }> = [
    { user_id: 'k129xyz', serial_number: '29' },
  ];
  let userListRows: Array<{ user_id: string; serial_number?: string; name?: string }> = [
    { user_id: 'k129xyz', serial_number: '29', name: 'Claude 29 号环境' },
    { user_id: 'k130abc', serial_number: '30', name: '' },
  ];
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
        status: 200,
        async json() {
          return { code: 0, msg: 'success', data: { list: activeList } };
        },
      } as Response;
    }
    if (parsed.pathname === '/api/v1/user/list') {
      return {
        ok: true,
        status: 200,
        async json() {
          return { code: 0, msg: 'success', data: { list: userListRows } };
        },
      } as Response;
    }
    return { ok: false, status: 404, async json() { return { code: -1 }; } } as Response;
  };

  try {
    // 1. 不传 adspowerApiUrl 时默认使用 http://127.0.0.1:50325；仅 1 个扩展上报且未填序号、本机恰好 1 个活跃环境 -> 自动查 local-active + user/list?page_size=100
    const store = registerBrowserUsage(
      { registerUsageSource(source) { registered = source; } },
      async () => ({ setUsageRoute() {}, snapshot: () => ({ settings: { enabled: true, port: 17373 } }) } as unknown as BrowserBridge),
      dir,
      () => now,
      { adspowerMinIntervalMs: 0, fetchFn: fakeFetch },
    );
    assert.ok(registered);
    const source = registered as UsageSourceRegistration;

    // session 作用域 discover 始终返回空数组
    assert.deepEqual(await source.discover({ kind: 'session', provider: 'claude', env: {} }), []);

    await store.record({
      instanceId: 'env-29',
      instanceName: '未命名浏览器环境',
      status: 'ok',
      observedAt: '2026-11-08T11:59:00.000Z',
      fiveHour: { usedPct: 25, resetsAt: '2026-11-08T16:00:00.000Z', observedAt: '2026-11-08T11:59:00.000Z' },
      weekly: { usedPct: 40, resetsAt: '2026-11-14T00:00:00.000Z', observedAt: '2026-11-08T11:59:00.000Z' },
    }, now);
    await store.flushQueries();

    assert.equal(apiCalls.length, 2);
    assert.equal(apiCalls[0]!.url, 'http://127.0.0.1:50325/api/v1/browser/local-active');
    assert.equal(apiCalls[0]!.auth, undefined);
    assert.equal(apiCalls[1]!.url, 'http://127.0.0.1:50325/api/v1/user/list?page_size=100');
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
    await store.flushQueries();
    assert.equal(apiCalls.length, 2);

    // 3. 第 2 个扩展开始上报：env-29 未配置序号，不再使用单环境自动识别结果，直接回退为 instanceName 并立即落盘；env-30 命中第一次 page_size=100 批量缓存，回退显示序号 "30"
    await store.record({
      instanceId: 'env-30',
      instanceName: '未命名浏览器环境',
      adspowerProfile: '30',
      status: 'ok',
      observedAt: new Date(now).toISOString(),
      fiveHour: { usedPct: 10, resetsAt: '2026-11-08T16:00:00.000Z', observedAt: new Date(now).toISOString() },
      weekly: { usedPct: 20, resetsAt: '2026-11-14T00:00:00.000Z', observedAt: new Date(now).toISOString() },
    }, now);
    await store.flushQueries();
    const rec29AfterMulti = await store.get('env-29', now);
    assert.equal(rec29AfterMulti?.displayName, '未命名浏览器环境');
    assert.equal(rec29AfterMulti?.labelSource, 'instance_name');
    const rec30 = await store.get('env-30', now);
    assert.equal(rec30?.displayName, '30');
    assert.equal(rec30?.labelSource, 'serial_number');
    assert.equal(rec30?.labelSourceText, 'AdsPower 序号');

    // 验证 clearAutoDetectedOnMultiInstance 清理其他记录后即使当前记录未变化也会立即落盘
    const diskAfterMulti = JSON.parse(await readFile(join(dir, 'browser-usage.json'), 'utf8'));
    const diskRec29 = diskAfterMulti.records.find((r: any) => r.instanceId === 'env-29');
    assert.equal(diskRec29?.displayName, '未命名浏览器环境');
    assert.equal(diskRec29?.adspowerName, undefined);

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
    await store.flushQueries();
    assert.equal(apiCalls.length, callsBeforeBind29);
    assert.equal((await store.get('env-29', now))?.displayName, 'Claude 29 号环境');
    assert.equal((await store.get('env-29', now))?.labelSource, 'adspower_name');

    // 5. 满 10 分钟后再次上报，且配置了 adspowerApiKey：重新请求 /api/v1/user/list?page_size=100 并携带 Authorization: Bearer
    now += 10 * 60_000;
    const authedStore = new BrowserUsageStore(dir, () => now, {
      adspowerApiKey: 'secret-adspower-key',
      adspowerMinIntervalMs: 0,
      fetchFn: fakeFetch,
    });
    await authedStore.load(now);
    userListRows = [
      { user_id: 'k129xyz', serial_number: '29', name: 'Claude 29 号改名后' },
      { user_id: 'k130abc', serial_number: '30', name: '' },
    ];
    await authedStore.record({
      instanceId: 'env-29',
      instanceName: '未命名浏览器环境',
      adspowerProfile: '29',
      status: 'ok',
      observedAt: new Date(now).toISOString(),
      fiveHour: { usedPct: 30, resetsAt: '2026-11-08T16:00:00.000Z', observedAt: new Date(now).toISOString() },
      weekly: { usedPct: 42, resetsAt: '2026-11-14T00:00:00.000Z', observedAt: new Date(now).toISOString() },
    }, now);
    await authedStore.flushQueries();
    assert.equal(apiCalls.at(-1)?.url, 'http://127.0.0.1:50325/api/v1/user/list?page_size=100');
    assert.equal(apiCalls.at(-1)?.auth, 'Bearer secret-adspower-key');
    assert.equal((await authedStore.get('env-29', now))?.displayName, 'Claude 29 号改名后');

    // 6. AdsPower API 失败时不影响额度上报：
    // (a) 只填了 user_id 时回退显示 user_id（labelSource: user_id）
    // (b) 既无序号也无 user_id 时回退显示 instanceName（labelSource: instance_name）
    // (c) 已有解析结果的（env-29）在满 10 分钟重新查询失败时保留上次名称，并写入 adspowerError: '连接失败'
    now += 10 * 60_000;
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
    await authedStore.record({
      instanceId: 'env-custom-fallback',
      instanceName: '我的自定义环境',
      status: 'ok',
      observedAt: new Date(now).toISOString(),
      fiveHour: { usedPct: 18, resetsAt: '2026-11-08T16:00:00.000Z', observedAt: new Date(now).toISOString() },
      weekly: { usedPct: 28, resetsAt: '2026-11-14T00:00:00.000Z', observedAt: new Date(now).toISOString() },
    }, now);
    await authedStore.record({
      instanceId: 'env-29',
      instanceName: '未命名浏览器环境',
      adspowerProfile: '29',
      status: 'ok',
      observedAt: new Date(now).toISOString(),
      fiveHour: { usedPct: 35, resetsAt: '2026-11-08T16:00:00.000Z', observedAt: new Date(now).toISOString() },
      weekly: { usedPct: 45, resetsAt: '2026-11-14T00:00:00.000Z', observedAt: new Date(now).toISOString() },
    }, now);
    await authedStore.flushQueries();

    const recUserId = await authedStore.get('env-userid', now);
    assert.equal(recUserId?.displayName, 'k1onlyid');
    assert.equal(recUserId?.labelSource, 'user_id');
    assert.equal(recUserId?.labelSourceText, 'AdsPower user_id');
    assert.equal(recUserId?.adspowerError, '连接失败');
    assert.equal(recUserId?.fiveHour?.usedPct, 15);

    const recCustomFallback = await authedStore.get('env-custom-fallback', now);
    assert.equal(recCustomFallback?.displayName, '我的自定义环境');
    assert.equal(recCustomFallback?.labelSource, 'instance_name');
    assert.equal(recCustomFallback?.labelSourceText, '扩展上报名称');

    const rec29Preserved = await authedStore.get('env-29', now);
    assert.equal(rec29Preserved?.displayName, 'Claude 29 号改名后');
    assert.equal(rec29Preserved?.labelSource, 'adspower_name');
    assert.equal(rec29Preserved?.adspowerError, '连接失败');
    assert.equal(rec29Preserved?.fiveHour?.usedPct, 35);
    const rep29Failed = toUsageReport(rec29Preserved, now, true);
    assert.equal(rep29Failed.status, 'available');
    assert.ok(rep29Failed.details?.some(d => d.id === 'adspower-error' && d.label === '环境名称' && d.value === 'AdsPower 查询失败（连接失败）'));
    assertNoAbsoluteTime(rep29Failed);

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
    await authedStore.flushQueries();

    now += 15 * 60_000;
    const reloaded = new BrowserUsageStore(dir, () => now, { adspowerMinIntervalMs: 0, fetchFn: fakeFetch });
    await reloaded.load(now);
    const discovered = await reloaded.discover(now);
    const keyDup1 = hashAccountKey('env-dup-1');
    const keyDup2 = hashAccountKey('env-dup-2');
    assert.deepEqual(discovered, [
      { key: hashAccountKey('env-29'), label: 'Claude 29 号改名后', input: { instanceId: 'env-29' } },
      { key: hashAccountKey('env-30'), label: '30', input: { instanceId: 'env-30' } },
      { key: hashAccountKey('env-userid'), label: 'k1onlyid', input: { instanceId: 'env-userid' } },
      { key: hashAccountKey('env-custom-fallback'), label: '我的自定义环境', input: { instanceId: 'env-custom-fallback' } },
      { key: keyDup1, label: `同名自定义环境 · ${keyDup1.slice(0, 4)}`, input: { instanceId: 'env-dup-1' } },
      { key: keyDup2, label: `同名自定义环境 · ${keyDup2.slice(0, 4)}`, input: { instanceId: 'env-dup-2' } },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AdsPower 错误分类与精确匹配：未配置 API key、已配置 API key 被拒、被限流、未找到环境（不拿 data.list[0] 顶替）均写入额度详情行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-usage-adspower-errors-'));
  let now = Date.parse('2026-11-08T12:00:00.000Z');
  let mode: 'need_key' | 'rate_limit' | 'other_rows_only' | 'ok' = 'need_key';

  const fakeFetch: typeof fetch = async () => {
    if (mode === 'need_key') {
      return {
        ok: true,
        status: 200,
        async json() {
          return { code: -1, msg: 'Need api key to access local API' };
        },
      } as Response;
    }
    if (mode === 'rate_limit') {
      return {
        ok: true,
        status: 200,
        async json() {
          return { code: -1, msg: 'Too many request per second' };
        },
      } as Response;
    }
    if (mode === 'other_rows_only') {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            code: 0,
            msg: 'success',
            data: {
              list: [
                { user_id: 'other_id_1', serial_number: '1', name: '第一条无关环境' },
                { user_id: 'other_id_2', serial_number: '2', name: '第二条无关环境' },
              ],
            },
          };
        },
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          code: 0,
          msg: 'success',
          data: {
            list: [{ user_id: 'k129xyz', serial_number: '29', name: 'Claude 29 号环境' }],
          },
        };
      },
    } as Response;
  };

  try {
    const store = new BrowserUsageStore(dir, () => now, { adspowerMinIntervalMs: 0, fetchFn: fakeFetch });
    const basePost = {
      instanceId: 'env-29',
      instanceName: '未命名浏览器环境',
      adspowerProfile: '29',
      status: 'ok' as const,
      observedAt: new Date(now).toISOString(),
      fiveHour: { usedPct: 20, resetsAt: '2026-11-08T16:00:00.000Z', observedAt: new Date(now).toISOString() },
      weekly: { usedPct: 30, resetsAt: '2026-11-14T00:00:00.000Z', observedAt: new Date(now).toISOString() },
    };

    // 1. 未配置 API key 且 AdsPower 返回 code !== 0 需要 key -> 原因显示“需要在额度设置填写 AdsPower API key”
    mode = 'need_key';
    await store.record(basePost, now);
    await store.flushQueries();
    let rec = await store.get('env-29', now);
    assert.equal(rec?.adspowerError, '需要在额度设置填写 AdsPower API key');
    let report = toUsageReport(rec, now, true);
    assert.equal(report.status, 'available');
    assert.deepEqual(report.details, [
      { id: 'adspower-error', label: '环境名称', value: 'AdsPower 查询失败（需要在额度设置填写 AdsPower API key）', tone: 'warning' },
      { id: 'synced', label: '同步时间', value: '刚刚' },
    ]);
    assertNoAbsoluteTime(report);

    // 2. 已配置 API key 但仍被拒绝 -> 原因显示“API key 无效，请在额度设置重新填写”
    await store.saveApiKey('wrong-key', now);
    await store.flushQueries();
    rec = await store.get('env-29', now);
    assert.equal(rec?.adspowerError, 'API key 无效，请在额度设置重新填写');
    report = toUsageReport(rec, now, true);
    assert.equal(report.status, 'available');
    assert.equal(report.details?.[0]?.value, 'AdsPower 查询失败（API key 无效，请在额度设置重新填写）');
    assertNoAbsoluteTime(report);

    // 3. 被限流（Too many request per second） -> 原因显示“被限流”
    now += 10 * 60_000;
    mode = 'rate_limit';
    await store.record({ ...basePost, observedAt: new Date(now).toISOString() }, now);
    await store.flushQueries();
    rec = await store.get('env-29', now);
    assert.equal(rec?.adspowerError, '被限流');
    report = toUsageReport(rec, now, true);
    assert.equal(report.status, 'available');
    assert.equal(report.details?.[0]?.value, 'AdsPower 查询失败（被限流）');
    assertNoAbsoluteTime(report);

    // 4. 列表非空但无精确匹配序号 29 -> 不拿列表第一条顶替，回退显示序号 29 且原因显示“未找到环境”
    now += 10 * 60_000;
    mode = 'other_rows_only';
    await store.record({ ...basePost, observedAt: new Date(now).toISOString() }, now);
    await store.flushQueries();
    rec = await store.get('env-29', now);
    assert.equal(rec?.displayName, '29');
    assert.equal(rec?.labelSource, 'serial_number');
    assert.equal(rec?.adspowerName, undefined);
    assert.equal(rec?.adspowerError, '未找到环境');
    report = toUsageReport(rec, now, true);
    assert.equal(report.status, 'available');
    assert.equal(report.details?.[0]?.value, 'AdsPower 查询失败（未找到环境）');
    assertNoAbsoluteTime(report);

    // 5. 恢复正常匹配后，清除 adspowerError 详情行并更新为精确匹配的 AdsPower 名称
    now += 10 * 60_000;
    mode = 'ok';
    await store.record({ ...basePost, observedAt: new Date(now).toISOString() }, now);
    await store.flushQueries();
    rec = await store.get('env-29', now);
    assert.equal(rec?.displayName, 'Claude 29 号环境');
    assert.equal(rec?.adspowerError, undefined);
    report = toUsageReport(rec, now, true);
    assert.equal(report.status, 'available');
    assert.equal(report.details?.some(d => d.id === 'adspower-error'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AdsPower 全局请求队列频率限制：默认间隔 1.1 秒串行排队，且并发请求严格按间隔依次执行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-usage-ratelimit-'));
  const now = Date.parse('2026-11-08T12:00:00.000Z');
  try {
    // 1. 验证默认最小间隔 1100ms（约 1.1 秒）：连续触发 3 次 AdsPower 请求（local-active + user/list + 另一未命中环境）通过 sleepFn 等待 >= 1000ms
    const sleptMs: number[] = [];
    const callOrder: string[] = [];
    const storeDefaultInterval = new BrowserUsageStore(dir, () => now, {
      sleepFn: async ms => {
        sleptMs.push(ms);
      },
      fetchFn: async input => {
        const url = new URL(String(input));
        callOrder.push(url.pathname + url.search);
        if (url.pathname === '/api/v1/browser/local-active') {
          return {
            ok: true,
            status: 200,
            async json() {
              return { code: 0, data: { list: [{ user_id: 'u1', serial_number: '29' }] } };
            },
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return { code: 0, data: { list: [{ user_id: 'u1', serial_number: '29', name: '环境 29' }] } };
          },
        } as Response;
      },
    });

    await storeDefaultInterval.record({
      instanceId: 'env-1',
      instanceName: '未命名浏览器环境',
      status: 'ok',
      observedAt: new Date(now).toISOString(),
      fiveHour: { usedPct: 10, resetsAt: null, observedAt: new Date(now).toISOString() },
      weekly: null,
    }, now);
    await storeDefaultInterval.flushQueries();
    assert.deepEqual(callOrder, ['/api/v1/browser/local-active', '/api/v1/user/list?page_size=100']);
    assert.equal(sleptMs.length, 1);
    assert.ok(sleptMs[0]! >= 1000 && sleptMs[0]! <= 1100, `期望默认等待约 1100ms，实际 ${sleptMs[0]}ms`);

    // 2. 验证真实计时器下连续两次请求的时间戳间隔 >= adspowerMinIntervalMs
    const callTimestamps: number[] = [];
    const realTimerStore = new BrowserUsageStore(dir, () => now + 20 * 60_000, {
      adspowerMinIntervalMs: 60,
      fetchFn: async () => {
        callTimestamps.push(Date.now());
        return {
          ok: true,
          status: 200,
          async json() {
            return { code: 0, data: { list: [{ user_id: 'u1', serial_number: '29' }] } };
          },
        } as Response;
      },
    });
    await realTimerStore.record({
      instanceId: 'env-real',
      instanceName: '未命名浏览器环境',
      status: 'ok',
      observedAt: new Date(now).toISOString(),
      fiveHour: { usedPct: 10, resetsAt: null, observedAt: new Date(now).toISOString() },
      weekly: null,
    }, now + 20 * 60_000);
    await realTimerStore.flushQueries();
    assert.equal(callTimestamps.length, 2);
    assert.ok(callTimestamps[1]! - callTimestamps[0]! >= 50, `真实间隔应 >= 50ms，实际 ${callTimestamps[1]! - callTimestamps[0]!}ms`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AdsPower 查询在队列外异步执行：查询挂起时不阻塞 store.record 与 BrowserBridge /sync，同一环境最多 1 个在途查询，完成后更新并落盘', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-usage-nonblocking-'));
  const bridge = new BrowserBridge(dir, async () => null);
  let registered: UsageSourceRegistration | null = null;
  let adspowerCalls = 0;
  let releaseAdsPower!: (res: Response) => void;
  const hungPromise = new Promise<Response>(resolve => {
    releaseAdsPower = resolve;
  });

  try {
    await bridge.start();
    await bridge.configure({ enabled: true, port: await randomPort() });
    const pairing = await bridge.pairing();
    const usageUrl = pairing.url.replace(/\/sync$/, '/usage');

    const store = registerBrowserUsage(
      { registerUsageSource(source) { registered = source; } },
      async () => bridge,
      dir,
      Date.now,
      {
        adspowerMinIntervalMs: 0,
        adspowerTimeoutMs: 10_000,
        fetchFn: async () => {
          adspowerCalls += 1;
          return hungPromise;
        },
      },
    );
    assert.ok(registered);

    const nowIso = new Date().toISOString();
    // 1. 发起第一次 /usage：触发挂起的 AdsPower 查询，但 /usage 立即返回 204
    const usageRes1 = await fetch(usageUrl, {
      method: 'POST',
      headers: { origin, authorization: `Bearer ${pairing.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        instanceId: 'env-29',
        instanceName: '29',
        adspowerProfile: '29',
        status: 'ok',
        observedAt: nowIso,
        fiveHour: { usedPct: 42, resetsAt: null, observedAt: nowIso },
        weekly: { usedPct: 55, resetsAt: null, observedAt: nowIso },
      }),
    });
    assert.equal(usageRes1.status, 204);
    assert.equal(adspowerCalls, 1);

    // 2. 在途查询尚未完成时同一环境再次上报 /usage：立即返回 204，且不重复发起第 2 个在途 AdsPower 查询
    const usageRes2 = await fetch(usageUrl, {
      method: 'POST',
      headers: { origin, authorization: `Bearer ${pairing.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        instanceId: 'env-29',
        instanceName: '29',
        adspowerProfile: '29',
        status: 'ok',
        observedAt: new Date(Date.now() + 1000).toISOString(),
        fiveHour: { usedPct: 45, resetsAt: null, observedAt: new Date(Date.now() + 1000).toISOString() },
        weekly: { usedPct: 55, resetsAt: null, observedAt: new Date(Date.now() + 1000).toISOString() },
      }),
    });
    assert.equal(usageRes2.status, 204);
    assert.equal(adspowerCalls, 1);

    // 3. AdsPower 查询挂起期间发送 /sync：不被阻塞，立即返回 200
    const syncStart = Date.now();
    const syncRes = await fetch(pairing.url, {
      method: 'POST',
      headers: { origin, authorization: `Bearer ${pairing.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        instanceId: 'env-29',
        instanceName: '29',
        sessions: [{ sessionId: 'sess1', title: '测试会话', url: 'https://claude.ai/code/session_sess1', tabCount: 1 }],
      }),
    });
    assert.equal(syncRes.status, 200);
    assert.ok(Date.now() - syncStart < 1000, '/sync 应立即返回而不被挂起的 AdsPower 查询阻塞');

    // 4. 释放挂起的 AdsPower 查询：后台更新 displayName 并持久化落盘到 browser-usage.json
    releaseAdsPower({
      ok: true,
      status: 200,
      async json() {
        return {
          code: 0,
          data: { list: [{ user_id: 'k129xyz', serial_number: '29', name: '异步解析完成的 29 号环境' }] },
        };
      },
    } as Response);
    await store.flushQueries();

    const updated = await store.get('env-29');
    assert.equal(updated?.displayName, '异步解析完成的 29 号环境');
    assert.equal(updated?.fiveHour?.usedPct, 45);
    const savedRaw = JSON.parse(await readFile(join(dir, 'browser-usage.json'), 'utf8'));
    assert.equal(savedRaw.records[0]?.displayName, '异步解析完成的 29 号环境');
  } finally {
    await bridge.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('额度设置 AdsPower API key：0600 落盘、不返回给前端、支持清除与重填、保留环境变量作为后备来源', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-usage-apikey-'));
  const now = Date.parse('2026-11-08T12:00:00.000Z');
  const prevEnv1 = process.env.PASEO_ADSPOWER_API_KEY;
  const prevEnv2 = process.env.ADSPOWER_API_KEY;
  delete process.env.PASEO_ADSPOWER_API_KEY;
  delete process.env.ADSPOWER_API_KEY;

  const receivedAuthHeaders: Array<string | undefined> = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    receivedAuthHeaders.push(headers.authorization);
    if (!headers.authorization) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { code: -1, msg: 'Need api key' };
        },
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          code: 0,
          data: { list: [{ user_id: 'k129xyz', serial_number: '29', name: '配置 Key 后解析成功' }] },
        };
      },
    } as Response;
  };

  try {
    const store = new BrowserUsageStore(dir, () => now, { adspowerMinIntervalMs: 0, fetchFn: fakeFetch });

    // 1. 初始未配置：settings() 返回 { adspowerApiKeyConfigured: false, adspowerApiKeySource: 'none' }，上报触发“需要在额度设置填写 AdsPower API key”
    assert.deepEqual(await store.settings(now), { adspowerApiKeyConfigured: false, adspowerApiKeySource: 'none' });
    await store.record({
      instanceId: 'env-29',
      instanceName: '29',
      adspowerProfile: '29',
      status: 'ok',
      observedAt: new Date(now).toISOString(),
      fiveHour: { usedPct: 30, resetsAt: null, observedAt: new Date(now).toISOString() },
      weekly: null,
    }, now);
    await store.flushQueries();
    assert.equal((await store.get('env-29', now))?.adspowerError, '需要在额度设置填写 AdsPower API key');

    // 2. 通过 controlStore / store.saveApiKey 保存 API key：前端收到 { adspowerApiKeyConfigured: true, adspowerApiKeySource: 'plugin' }，不含明文或前缀，0600 落盘，且自动重查成功
    const secretKey = 'adspower_secret_key_99887766';
    const clientControl = createControlStore(
      {
        rpc: (async (contract: { name: string }, input: any) => {
          if (contract.name === 'browser.usage.snapshot') return store.settings(now);
          if (contract.name === 'browser.usage.save_api_key') return store.saveApiKey(input.apiKey, now);
          if (contract.name === 'browser.usage.remove_api_key') return store.removeApiKey(now);
          throw new Error(`unexpected ${contract.name}`);
        }) as any,
      },
      (async () => ({ entries: [], pageInfo: { hasMore: false } })) as any,
    );

    try {
      const savedStatus = await clientControl.saveAdsPowerApiKey(secretKey);
      assert.deepEqual(savedStatus, { adspowerApiKeyConfigured: true, adspowerApiKeySource: 'plugin' });
      assert.equal(JSON.stringify(savedStatus).includes(secretKey), false);
      const queriedStatus = await clientControl.usageSettings();
      assert.deepEqual(queriedStatus, { adspowerApiKeyConfigured: true, adspowerApiKeySource: 'plugin' });
      assert.equal(JSON.stringify(queriedStatus).includes(secretKey), false);

      await store.flushQueries();
      const fileStat = await stat(join(dir, 'browser-usage.json'));
      assert.equal(fileStat.mode & 0o777, 0o600);
      assert.equal(receivedAuthHeaders.at(-1), `Bearer ${secretKey}`);
      const recAfterKey = await store.get('env-29', now);
      assert.equal(recAfterKey?.displayName, '配置 Key 后解析成功');
      assert.equal(recAfterKey?.adspowerError, undefined);

      // 3. 重新填写新 API key
      const newKey = 'adspower_new_key_11223344';
      assert.deepEqual(await clientControl.saveAdsPowerApiKey(newKey), { adspowerApiKeyConfigured: true, adspowerApiKeySource: 'plugin' });

      // 4. 清除 API key：无环境变量时变为未配置（source: 'none'），状态文件中不再包含 key
      assert.deepEqual(await clientControl.removeAdsPowerApiKey(), { adspowerApiKeyConfigured: false, adspowerApiKeySource: 'none' });
      const diskText = await readFile(join(dir, 'browser-usage.json'), 'utf8');
      assert.equal(diskText.includes(secretKey), false);
      assert.equal(diskText.includes(newKey), false);

      // 5. 环境变量作为后备来源：设置 PASEO_ADSPOWER_API_KEY 后，即使插件内已清除 key，仍识别为已配置（source: 'env'）并携带环境变量 key
      process.env.PASEO_ADSPOWER_API_KEY = 'env_fallback_key_5566';
      assert.deepEqual(await clientControl.usageSettings(), { adspowerApiKeyConfigured: true, adspowerApiKeySource: 'env' });
      await store.record({
        instanceId: 'env-30',
        instanceName: '30',
        adspowerProfile: '30',
        status: 'ok',
        observedAt: new Date(now).toISOString(),
        fiveHour: { usedPct: 10, resetsAt: null, observedAt: new Date(now).toISOString() },
        weekly: null,
      }, now);
      await store.flushQueries();
      assert.equal(receivedAuthHeaders.at(-1), 'Bearer env_fallback_key_5566');
    } finally {
      clientControl.dispose();
    }
  } finally {
    if (prevEnv1 === undefined) delete process.env.PASEO_ADSPOWER_API_KEY;
    else process.env.PASEO_ADSPOWER_API_KEY = prevEnv1;
    if (prevEnv2 === undefined) delete process.env.ADSPOWER_API_KEY;
    else process.env.ADSPOWER_API_KEY = prevEnv2;
    await rm(dir, { recursive: true, force: true });
  }
});

test('向后兼容旧版 account 字段：旧 browser-usage.json 状态文件可正常加载并剥离 account，旧扩展上报带 account 不返 400', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-usage-compat-account-'));
  const now = Date.parse('2026-11-08T12:00:00.000Z');
  const bridge = new BrowserBridge(dir, async () => null);
  try {
    // 1. 写入含旧版 account 字段的 browser-usage.json
    await writeFile(
      join(dir, 'browser-usage.json'),
      JSON.stringify({
        records: [
          {
            instanceId: 'env-legacy',
            instanceName: '旧环境',
            account: 'legacy-user@example.com',
            lastPostAt: now - 10_000,
            status: 'ok',
            fiveHour: { usedPct: 33, resetsAt: '2026-11-08T16:00:00.000Z', observedAt: '2026-11-08T11:55:00.000Z' },
            weekly: { usedPct: 44, resetsAt: '2026-11-14T00:00:00.000Z', observedAt: '2026-11-08T11:55:00.000Z' },
          },
        ],
      }),
      { mode: 0o600 },
    );

    await bridge.start();
    await bridge.configure({ enabled: true, port: await randomPort() });
    const pairing = await bridge.pairing();
    const usageUrl = pairing.url.replace(/\/sync$/, '/usage');

    const store = registerBrowserUsage(
      { registerUsageSource() {} },
      async () => bridge,
      dir,
      () => now,
      { adspowerMinIntervalMs: 0, fetchFn: async () => { throw new Error('offline'); } },
    );
    await store.load(now);

    const loadedLegacy = await store.get('env-legacy', now);
    assert.ok(loadedLegacy);
    assert.equal(loadedLegacy.instanceName, '旧环境');
    assert.equal('account' in loadedLegacy, false);

    // 2. 旧版扩展 POST /usage 携带 account 字段：返回 204（不返 400），记录中丢弃 account
    const nowIso = new Date(now).toISOString();
    const res = await fetch(usageUrl, {
      method: 'POST',
      headers: { origin, authorization: `Bearer ${pairing.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        instanceId: 'env-legacy-ext',
        instanceName: '旧扩展上报',
        account: 'old-ext@example.com',
        status: 'ok',
        observedAt: nowIso,
        fiveHour: { usedPct: 50, resetsAt: null, observedAt: nowIso },
        weekly: null,
      }),
    });
    assert.equal(res.status, 204);
    const savedExt = await store.get('env-legacy-ext', now);
    assert.ok(savedExt);
    assert.equal('account' in savedExt, false);
    assert.equal(savedExt.fiveHour?.usedPct, 50);
  } finally {
    await bridge.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('AdsPower 本地 API 边界条件：local-active 返回多个活跃环境时不猜测，请求超时中止并按顺序回退且不影响额度写入', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-usage-adspower-edge-'));
  const now = Date.parse('2026-11-08T12:00:00.000Z');
  try {
    // 1. 本机有 2 个活跃环境时，即使只有 1 个扩展上报，也不猜测，回退显示 instanceName
    const multiActiveStore = new BrowserUsageStore(dir, () => now, {
      adspowerMinIntervalMs: 0,
      fetchFn: async () => ({
        ok: true,
        status: 200,
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
    await multiActiveStore.flushQueries();
    const recMulti = await multiActiveStore.get('env-single-ext', now);
    assert.equal(recMulti?.displayName, '未命名浏览器环境');
    assert.equal(recMulti?.labelSource, 'instance_name');
    assert.equal(recMulti?.fiveHour?.usedPct, 33);

    // 2. AdsPower API 响应超时时由 AbortSignal 中止，回退显示序号且额度正常保存，adspowerError 为“连接失败”
    let aborted = false;
    const timeoutStore = new BrowserUsageStore(dir, () => now, {
      adspowerMinIntervalMs: 0,
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
    await timeoutStore.flushQueries();
    assert.equal(aborted, true);
    const recTimeout = await timeoutStore.get('env-timeout', now);
    assert.equal(recTimeout?.displayName, '29');
    assert.equal(recTimeout?.labelSource, 'serial_number');
    assert.equal(recTimeout?.adspowerError, '连接失败');
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
    const store = new BrowserUsageStore(dir, () => now, { adspowerMinIntervalMs: 0 });
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
    const restored = new BrowserUsageStore(dir, () => now, { adspowerMinIntervalMs: 0 });
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

test('批量 user/list?page_size=100 未命中时自动使用 serial_number 或 user_id 过滤参数二次查询，仍走全局限速队列', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-usage-fallback-filter-'));
  const now = Date.parse('2026-11-08T12:00:00.000Z');
  const calls: string[] = [];
  const sleptMs: number[] = [];

  try {
    const store = new BrowserUsageStore(dir, () => now, {
      sleepFn: async ms => {
        sleptMs.push(ms);
      },
      fetchFn: async input => {
        const url = new URL(String(input));
        calls.push(url.pathname + url.search);
        if (url.searchParams.get('page_size') === '100') {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                code: 0,
                data: {
                  list: [{ user_id: 'k1', serial_number: '1', name: '第 1 号环境' }],
                },
              };
            },
          } as Response;
        }
        if (url.searchParams.get('serial_number') === '105') {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                code: 0,
                data: {
                  list: [{ user_id: 'k105', serial_number: '105', name: '第 105 号分页外环境' }],
                },
              };
            },
          } as Response;
        }
        if (url.searchParams.get('user_id') === 'k205id') {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                code: 0,
                data: {
                  list: [{ user_id: 'k205id', serial_number: '205', name: '第 205 号 ID 过滤环境' }],
                },
              };
            },
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return { code: 0, data: { list: [] } };
          },
        } as Response;
      },
    });

    await store.record({
      instanceId: 'env-105',
      instanceName: '未命名浏览器环境',
      adspowerProfile: '105',
      status: 'ok',
      observedAt: new Date(now).toISOString(),
      fiveHour: { usedPct: 22, resetsAt: null, observedAt: new Date(now).toISOString() },
      weekly: null,
    }, now);
    await store.flushQueries();

    assert.deepEqual(calls, [
      '/api/v1/user/list?page_size=100',
      '/api/v1/user/list?serial_number=105',
    ]);
    assert.equal(sleptMs.length, 1);
    assert.ok(sleptMs[0]! >= 1000, `二次过滤查询同样走全局限速队列，等待 ${sleptMs[0]}ms`);
    const rec105 = await store.get('env-105', now);
    assert.equal(rec105?.displayName, '第 105 号分页外环境');
    assert.equal(rec105?.labelSource, 'adspower_name');
    assert.equal(rec105?.adspowerError, undefined);

    // 按 user_id 过滤参数二次查询同样生效
    await store.record({
      instanceId: 'env-205',
      instanceName: '未命名浏览器环境',
      adspowerProfile: 'k205id',
      status: 'ok',
      observedAt: new Date(now).toISOString(),
      fiveHour: { usedPct: 32, resetsAt: null, observedAt: new Date(now).toISOString() },
      weekly: null,
    }, now);
    await store.flushQueries();
    assert.equal(calls.at(-1), '/api/v1/user/list?user_id=k205id');
    const rec205 = await store.get('env-205', now);
    assert.equal(rec205?.displayName, '第 205 号 ID 过滤环境');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('保存或清除 API key 时递增版本号：丢弃旧版本在途查询结果并立即启动新版本查询', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-usage-key-version-'));
  const now = Date.parse('2026-11-08T12:00:00.000Z');
  let resolveOldQuery!: (res: Response) => void;
  const oldHungQuery = new Promise<Response>(resolve => {
    resolveOldQuery = resolve;
  });
  const authSeen: Array<string | undefined> = [];

  try {
    const store = new BrowserUsageStore(dir, () => now, {
      adspowerMinIntervalMs: 0,
      fetchFn: async (_input, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        authSeen.push(headers.authorization);
        // 第一次无 key 请求挂起，模拟慢旧请求
        if (authSeen.length === 1) {
          return oldHungQuery;
        }
        // 新版本带新 key 的请求立即返回正确名称
        if (headers.authorization === 'Bearer fresh-valid-key') {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                code: 0,
                data: { list: [{ user_id: 'k29', serial_number: '29', name: '新版本 Key 解析名称' }] },
              };
            },
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return { code: -1, msg: 'Need api key' };
          },
        } as Response;
      },
    });

    // 1. 触发旧版本（无 key）在途查询，处于挂起状态
    await store.record({
      instanceId: 'env-29',
      instanceName: '29',
      adspowerProfile: '29',
      status: 'ok',
      observedAt: new Date(now).toISOString(),
      fiveHour: { usedPct: 20, resetsAt: null, observedAt: new Date(now).toISOString() },
      weekly: null,
    }, now);
    assert.equal(authSeen.length, 1);
    assert.equal(authSeen[0], undefined);

    // 2. 旧查询尚未返回时调用 saveApiKey：递增版本号并立即启动新版本查询（不被旧在途查询挡住）
    await store.saveApiKey('fresh-valid-key', now);

    // 3. 让旧版本查询晚于新版本发起后才返回错误（或旧名称）：旧版本结果必须被丢弃，不能覆盖新版本结果
    resolveOldQuery({
      ok: true,
      status: 200,
      async json() {
        return { code: -1, msg: 'Need api key' };
      },
    } as Response);
    await store.flushQueries();

    assert.equal(authSeen.length, 2);
    assert.equal(authSeen[1], 'Bearer fresh-valid-key');
    const rec = await store.get('env-29', now);
    assert.equal(rec?.displayName, '新版本 Key 解析名称');
    assert.equal(rec?.adspowerError, undefined);

    // 4. 调用 removeApiKey 同样递增版本号并立即重查
    await store.removeApiKey(now);
    await store.flushQueries();
    assert.equal(authSeen.at(-1), undefined);
    const recAfterRemove = await store.get('env-29', now);
    assert.equal(recAfterRemove?.displayName, '新版本 Key 解析名称');
    assert.equal(recAfterRemove?.adspowerError, '需要在额度设置填写 AdsPower API key');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('额度模块 stop()：设置停止标志、中止在途请求，停止后后台查询结果不写入内存或磁盘', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-usage-stop-'));
  const now = Date.parse('2026-11-08T12:00:00.000Z');
  let signalAborted = false;
  let resolveHung!: (res: Response) => void;
  const hung = new Promise<Response>(resolve => {
    resolveHung = resolve;
  });

  try {
    const store = new BrowserUsageStore(dir, () => now, {
      adspowerMinIntervalMs: 0,
      fetchFn: async (_url, init) => {
        init?.signal?.addEventListener('abort', () => {
          signalAborted = true;
        });
        return hung;
      },
    });

    await store.record({
      instanceId: 'env-stop',
      instanceName: '29',
      adspowerProfile: '29',
      status: 'ok',
      observedAt: new Date(now).toISOString(),
      fiveHour: { usedPct: 12, resetsAt: null, observedAt: new Date(now).toISOString() },
      weekly: null,
    }, now);

    // 调用 stop()，中止在途请求；随后即使旧 Promise 被 resolve，也不得更新记录或写盘
    const stopPromise = store.stop();
    assert.equal(signalAborted, true);
    resolveHung({
      ok: true,
      status: 200,
      async json() {
        return {
          code: 0,
          data: { list: [{ user_id: 'k29', serial_number: '29', name: '停止后不应写入的名称' }] },
        };
      },
    } as Response);
    await stopPromise;

    const rec = await store.get('env-stop', now);
    assert.equal(rec?.displayName, '29');
    assert.equal(rec?.adspowerName, undefined);
    const disk = JSON.parse(await readFile(join(dir, 'browser-usage.json'), 'utf8'));
    assert.equal(disk.records[0]?.displayName, '29');
    assert.equal(disk.records[0]?.adspowerName, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AdsPowerKeyCard 前端界面：key 来自环境变量时显示“已配置（来自环境变量）”并隐藏清除按钮，来自插件设置时显示清除按钮', async () => {
  const { installTsxAndReactNativeHooks } = await import('./ui/presence-panel.ts');
  installTsxAndReactNativeHooks();
  const React = (await import('react')).default;
  const { isValidElement } = await import('react');
  const { AdsPowerKeyCard } = await import('../client/settings/index.tsx');
  const { bind } = await import('../client/ui.tsx');

  const mockTheme = {
    colors: {
      surface0: '#ffffff',
      surface1: '#f6f6f6',
      surface2: '#ececee',
      border: '#e4e4e7',
      foreground: '#1f1f22',
      foregroundMuted: '#8a8a90',
      accent: '#2f6bf0',
      accentForeground: '#ffffff',
      statusSuccess: '#2e9a52',
      statusWarning: '#c27a07',
      statusDanger: '#d6403a',
    },
  };

  interface NodeTree {
    type: string;
    props: Record<string, unknown>;
    children: Array<NodeTree | string>;
  }

  const contextValues = new Map<unknown, unknown>();
  const dispatcher = (
    (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: { H: Record<string, unknown> } })
      .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  );

  function renderTree(element: unknown): NodeTree | string {
    if (element === null || element === undefined || typeof element === 'boolean') return '';
    if (typeof element === 'string' || typeof element === 'number') return String(element);
    if (Array.isArray(element)) {
      return { type: 'Fragment', props: {}, children: element.map(renderTree).filter(c => c !== '') };
    }
    if (!isValidElement(element)) return '';
    const el = element as { type: unknown; props: Record<string, unknown> };
    if (typeof el.type === 'function') {
      const proto = (el.type as { prototype?: { isReactComponent?: boolean } }).prototype;
      if (proto && proto.isReactComponent) {
        const Ctor = el.type as unknown as new (props: Record<string, unknown>) => { render(): unknown };
        return renderTree(new Ctor(el.props).render());
      }
      return renderTree((el.type as (props: Record<string, unknown>) => unknown)(el.props));
    }
    if (typeof el.type === 'object' && el.type !== null && 'value' in el.props) {
      contextValues.set((el.type as { _context?: unknown })._context ?? el.type, el.props.value);
      return renderTree(el.props.children);
    }
    const rawChildren = el.props.children;
    const childList = Array.isArray(rawChildren) ? rawChildren : rawChildren !== undefined ? [rawChildren] : [];
    return {
      type: String(el.type),
      props: el.props,
      children: childList.map(renderTree).filter(c => c !== ''),
    };
  }

  function collectText(node: NodeTree | string): string {
    if (typeof node === 'string') return node;
    return node.children.map(collectText).join('');
  }

  function renderWithSettings(settingsState: { adspowerApiKeyConfigured: boolean; adspowerApiKeySource: 'plugin' | 'env' | 'none' }): string {
    const hookStates: unknown[] = [Date.now(), settingsState, '', null, null];
    let hookCursor = 0;
    const prevH = dispatcher?.H;
    if (dispatcher) {
      dispatcher.H = {
        useState(init: unknown) {
          const idx = hookCursor++;
          if (idx >= hookStates.length) {
            hookStates[idx] = typeof init === 'function' ? (init as () => unknown)() : init;
          }
          return [hookStates[idx], () => {}];
        },
        useEffect() {},
        useMemo(fn: () => unknown) { return fn(); },
        useContext(ctx: { _currentValue?: unknown }) {
          return contextValues.has(ctx) ? contextValues.get(ctx) : ctx._currentValue;
        },
      };
    }
    try {
      const Bound = bind(
        {
          store: { subscribe: () => () => {}, getState: () => ({} as never) } as never,
          control: {
            subscribe: () => () => {},
            getState: () => ({} as never),
            usageSettings: async () => settingsState,
          } as never,
          openScreen: () => {},
        },
        () => React.createElement(AdsPowerKeyCard),
      );
      const tree = renderTree(
        React.createElement(Bound as unknown as React.ComponentType<Record<string, unknown>>, {
          theme: mockTheme,
          host: { id: 'h1', label: 'Host' },
          layout: { compact: false, platform: 'web' },
        }),
      );
      return collectText(tree);
    } finally {
      if (dispatcher && prevH) dispatcher.H = prevH;
    }
  }

  // 1. 来自环境变量：显示“已配置（来自环境变量）”，且隐藏“清除 API key”按钮
  const envText = renderWithSettings({ adspowerApiKeyConfigured: true, adspowerApiKeySource: 'env' });
  assert.ok(envText.includes('已配置（来自环境变量）'));
  assert.equal(envText.includes('清除 API key'), false);

  // 2. 来自插件设置：显示“已配置”，且显示“清除 API key”按钮
  const pluginText = renderWithSettings({ adspowerApiKeyConfigured: true, adspowerApiKeySource: 'plugin' });
  assert.ok(pluginText.includes('当前状态：已配置'));
  assert.equal(pluginText.includes('已配置（来自环境变量）'), false);
  assert.ok(pluginText.includes('清除 API key'));

  // 3. 未配置：显示“未配置”，且隐藏“清除 API key”按钮
  const noneText = renderWithSettings({ adspowerApiKeyConfigured: false, adspowerApiKeySource: 'none' });
  assert.ok(noneText.includes('当前状态：未配置'));
  assert.equal(noneText.includes('清除 API key'), false);
});
