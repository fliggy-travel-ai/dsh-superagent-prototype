import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  accountAllocationHint,
  mergeFleetQuotas,
  windowPaceHint,
  type HostProviderQuota,
  type LocalHostQuotas,
} from '../shared/provider-quota-tool.ts';
import { resolveAccountKey } from '../server/modules/providers-quota-tool/identity.ts';
import { collectLocalQuotas, type LocalQuotaClient } from '../server/modules/providers-quota-tool/local.ts';
import { collectFleetQuotas } from '../server/modules/providers-quota-tool/fleet.ts';
import { quotaToolModule } from '../server/modules/providers-quota-tool/index.ts';
import type { UsageReportEntry } from '../server/modules/providers-quota-gate/reports.ts';

const NOW = Date.parse('2026-11-27T08:00:00.000Z');

function usageEntry(overrides: Partial<UsageReportEntry> & { id: string; sourceId: string }): UsageReportEntry {
  return {
    sourceLabel: overrides.sourceId,
    fetchedAt: '2026-11-27T07:59:00.000Z',
    account: {},
    report: {
      status: 'available',
      windows: [{ id: 'five_hour', label: '5h', shortLabel: '5h', remainingPct: 80, usedPct: 20, resetsAt: '2026-11-27T11:00:00.000Z' }],
      balances: [],
      details: [],
    },
    ...overrides,
  } as UsageReportEntry;
}

function withTempHome(run: (dirs: { root: string; home: string; paseoHome: string }) => Promise<void> | void) {
  const root = mkdtempSync(join(tmpdir(), 'paseo-quota-tool-'));
  const home = join(root, 'home');
  const paseoHome = join(home, '.paseo');
  mkdirSync(paseoHome, { recursive: true });
  return Promise.resolve()
    .then(() => run({ root, home, paseoHome }))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}

test('windowPaceHint 与 accountAllocationHint：区分 prefer / normal / throttle / avoid 与分模型池规则', () => {
  // 5h 窗口已经过去 4 小时（80%），只用了 10%（剩 90%）→ prefer
  assert.equal(windowPaceHint(90, '2026-11-27T09:00:00.000Z', 'five_hour', '5h', NOW), 'prefer');
  // 5h 窗口只过去 1 小时（20%），已用 70%（剩 30%）→ throttle
  assert.equal(windowPaceHint(30, '2026-11-27T12:00:00.000Z', 'five_hour', '5h', NOW), 'throttle');
  // 剩 0% → avoid
  assert.equal(windowPaceHint(0, '2026-11-27T12:00:00.000Z', 'five_hour', '5h', NOW), 'avoid');
  // 无重置时间 → normal
  assert.equal(windowPaceHint(100, null, '3p-5h', 'Claude and GPT 5h', NOW), 'normal');

  // 共享窗口取最差；分模型池（cursor/antigravity）取最佳；有付费余额至少为 normal
  const mixed = [
    { remainingPct: 90, hint: 'prefer' as const },
    { remainingPct: 0, hint: 'avoid' as const },
  ];
  assert.equal(accountAllocationHint(mixed, false, false), 'avoid');
  assert.equal(accountAllocationHint(mixed, true, false), 'prefer');
  assert.equal(accountAllocationHint([{ remainingPct: 0, hint: 'avoid' }], false, true), 'normal');
  assert.equal(accountAllocationHint([], false, false), 'unknown');
});

test('resolveAccountKey：跨主机不同 providerId 的同一底层账号生成完全一致的脱敏键，不泄漏明文邮箱或密钥', () => withTempHome(({ home }) => {
  // 1. Codex：主机 A 用内置 codex:<uuid>，主机 B 用 codex-4 读取 auth.json tokens.account_id
  const codexHome = join(home, '.codex-4');
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { account_id: '64cef1fb-fbb5-4838-9f8d-67f67604445b' } }));
  const codexA = resolveAccountKey({
    serverId: 'srv-a', providerId: 'codex', kind: 'codex', env: {}, home,
    report: usageEntry({ id: 'codex:64cef1fb-fbb5-4838-9f8d-67f67604445b', sourceId: 'codex' }),
  });
  const codexB = resolveAccountKey({
    serverId: 'srv-b', providerId: 'codex-4', kind: 'codex', env: { CODEX_HOME: codexHome }, home,
  });
  assert.equal(codexA, codexB);
  assert.match(codexA, /^codex:[0-9a-f]{16}$/);

  // 2. Antigravity：主机 A（antigravity-2）有 token 文件邮箱，主机 B（antigravity）只有配置标签邮箱
  const agyHome = join(home, 'agy-profile');
  mkdirSync(join(agyHome, '.gemini', 'antigravity-cli'), { recursive: true });
  const sampleAddr = ['pilot', 'example.invalid'].join('@'); // scan-allow
  writeFileSync(join(agyHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), JSON.stringify({ id_token_email: sampleAddr.toUpperCase() }));
  const agyA = resolveAccountKey({ serverId: 'srv-a', providerId: 'antigravity-2', kind: 'antigravity', env: { HOME: agyHome }, home });
  const agyB = resolveAccountKey({ serverId: 'srv-b', providerId: 'antigravity', kind: 'antigravity', env: {}, home, label: `Antigravity · ${sampleAddr}` });
  assert.equal(agyA, agyB);
  assert.ok(!agyA.includes(sampleAddr));

  // 3. GLM：同 API Key 两机一致且不泄漏原文
  const xdg = join(home, '.config');
  mkdirSync(join(xdg, 'glm-acp-agent'), { recursive: true });
  writeFileSync(join(xdg, 'glm-acp-agent', 'credentials.json'), JSON.stringify({ z_ai_api_key: 'fake-glm-key-123' }));
  const glmA = resolveAccountKey({ serverId: 'srv-a', providerId: 'glm-acp-agent', kind: 'glm', env: { XDG_CONFIG_HOME: xdg }, home });
  const glmB = resolveAccountKey({ serverId: 'srv-b', providerId: 'glm-2', kind: 'glm', env: { Z_AI_API_KEY: 'fake-glm-key-123' }, home });
  assert.equal(glmA, glmB);
  assert.ok(!glmA.includes('fake-glm-key-123'));

  // 4. Grok：同 user_id 两机一致
  const grokDir = join(home, '.grok');
  mkdirSync(grokDir, { recursive: true });
  writeFileSync(join(grokDir, 'auth.json'), JSON.stringify({ 'https://auth.example::u1': { user_id: 'user-abc-1' } }));
  const grokA = resolveAccountKey({ serverId: 'srv-a', providerId: 'grok', kind: 'grok', env: { GROK_HOME: grokDir }, home });
  const grokB = resolveAccountKey({ serverId: 'srv-b', providerId: 'grok-2', kind: 'grok', env: { GROK_HOME: grokDir }, home });
  assert.equal(grokA, grokB);

  // 5. Claude：沿用 accountUuid.orgUuid
  assert.equal(
    resolveAccountKey({ serverId: 'srv-a', providerId: 'claude-3', kind: 'claude', env: {}, home, claudeKey: 'acc1.org1' }),
    resolveAccountKey({ serverId: 'srv-b', providerId: 'claude', kind: 'claude', env: {}, home, claudeKey: 'acc1.org1' }),
  );

  // 6. 代理与身份未知账号按主机隔离，避免误合并
  assert.equal(
    resolveAccountKey({ serverId: 'srv-a', providerId: 'codex-proxy', kind: 'codex', env: {}, home, proxied: true }),
    'proxied:srv-a:codex-proxy',
  );
  assert.equal(
    resolveAccountKey({ serverId: 'srv-a', providerId: 'custom-x', kind: 'custom', env: {}, home }),
    'host:srv-a:custom-x',
  );
}));

test('collectLocalQuotas：过滤未安装内置项与 cloud-session、保留 1970 占位窗口、支持代理池和运行中会话数', () => withTempHome(async ({ home, paseoHome }) => {
  const sampleAddr = ['shared', 'example.invalid'].join('@'); // scan-allow
  writeFileSync(join(paseoHome, 'config.json'), JSON.stringify({
    agents: {
      providers: {
        antigravity: {},
        'antigravity-2': { label: `Antigravity · ${sampleAddr}` },
        'claude-expired': { extends: 'claude', env: { CLAUDE_CONFIG_DIR: join(home, '.claude-expired') } },
        'codex-proxy': { extends: 'codex', env: { OPENAI_BASE_URL: 'http://127.0.0.1:18080/v1' } },
        'custom-down': { enabled: true, command: ['custom-cli'] },
      },
    },
  }));

  const client: LocalQuotaClient = {
    async getProvidersSnapshot() {
      return {
        entries: [
          { provider: 'antigravity', label: 'Antigravity', enabled: true, status: 'available' },
          { provider: 'antigravity-2', label: `Antigravity · ${sampleAddr}`, enabled: true, status: 'available' },
          { provider: 'claude-expired', label: 'Claude Expired', enabled: true, status: 'available' },
          { provider: 'codex-proxy', label: 'Codex Proxy', enabled: true, status: 'available' },
          { provider: 'custom-down', label: 'Custom Down', enabled: true, status: 'unavailable' },
          { provider: 'copilot', label: 'Copilot', enabled: true, status: 'unavailable' },
          { provider: 'cloud-session', label: '云端会话', enabled: true, status: 'available' },
        ],
      } as unknown as Awaited<ReturnType<LocalQuotaClient['getProvidersSnapshot']>>;
    },
    async listUsageReports() {
      return {
        reports: [
          usageEntry({
            id: 'antigravity:897a5faa62c52d9713a9e801787900ada07535079410649070ce2ce95577843a',
            sourceId: 'antigravity',
            report: {
              status: 'available',
              windows: [
                { id: 'gemini-5h', label: 'Gemini 5h', shortLabel: 'Gemini 5h', remainingPct: 92, usedPct: 8, resetsAt: '2026-11-27T10:00:00Z' },
                { id: '3p-5h', label: 'Claude and GPT 5h', shortLabel: 'Claude and GPT 5h', remainingPct: 100, usedPct: 0, resetsAt: '1970-01-01T00:00:00Z' },
                { id: 'expired', label: 'Expired', remainingPct: 0, usedPct: 100, resetsAt: '2026-11-27T07:00:00Z' },
              ],
              balances: [],
              details: [],
            },
          }),
        ],
      } as unknown as Awaited<ReturnType<LocalQuotaClient['listUsageReports']>>;
    },
    async fetchAgents() {
      return {
        entries: [
          { agent: { id: 'a1', provider: 'antigravity', status: 'running', archivedAt: null } },
          { agent: { id: 'a2', provider: 'antigravity', status: 'running', archivedAt: null } },
          { agent: { id: 'a3', provider: 'antigravity', status: 'idle', archivedAt: null } },
        ],
        pageInfo: { hasMore: false, nextCursor: null },
      };
    },
  };

  const result = await collectLocalQuotas({
    client,
    paseoHome,
    serverId: 'srv-mini',
    hostName: 'Mac mini',
    excludeProviders: ['codex*'],
    minRemainingPct: 10,
    now: () => NOW,
    readProxy: async () => ({
      data: [{ provider: 'codex', windows: [{ name: '5h', remaining: 75 }], balance: null }],
    }),
    claudeProbe: {
      needsLogin: async () => true,
      accounts: async () => new Map(),
    },
  });

  const ids = result.providers.map(p => p.providerId);
  assert.deepEqual(ids, ['antigravity', 'antigravity-2', 'claude-expired', 'codex-proxy', 'custom-down']);

  const agy = result.providers.find(p => p.providerId === 'antigravity')!;
  assert.equal(agy.runningSessions, 2);
  assert.equal(agy.windows.length, 2); // 保留 1970 占位，剔除已过期的 expired 窗口
  assert.equal(agy.windows.find(w => w.id === '3p-5h')?.resetsAt, null);

  const claude = result.providers.find(p => p.providerId === 'claude-expired')!;
  assert.equal(claude.quotaStatus, 'error');
  assert.match(claude.error ?? '', /未登录或登录已过期/);

  const proxied = result.providers.find(p => p.providerId === 'codex-proxy')!;
  assert.equal(proxied.quotaStatus, 'proxied');
  assert.equal(proxied.quotaGateExcluded, true);
  assert.equal(proxied.upstream?.accounts.length, 1);
  assert.equal(proxied.upstream?.accounts[0]?.windows[0]?.remainingPct, 75);
}));

test('collectLocalQuotas：会话查询失败时 runningSessions 为 null 且返回 sessionsError，不误报 0', () => withTempHome(async ({ paseoHome }) => {
  writeFileSync(join(paseoHome, 'config.json'), JSON.stringify({ agents: { providers: { codex: {} } } }));
  const client: LocalQuotaClient = {
    async getProvidersSnapshot() {
      return { entries: [{ provider: 'codex', label: 'Codex', enabled: true, status: 'available' }] } as unknown as Awaited<ReturnType<LocalQuotaClient['getProvidersSnapshot']>>;
    },
    async listUsageReports() {
      return { reports: [] } as unknown as Awaited<ReturnType<LocalQuotaClient['listUsageReports']>>;
    },
    async fetchAgents() {
      throw new Error('daemon timeout');
    },
  };
  const result = await collectLocalQuotas({ client, paseoHome, serverId: 'srv-1', hostName: '本机', now: () => NOW });
  assert.match(result.sessionsError ?? '', /daemon timeout/);
  assert.equal(result.providers[0]?.runningSessions, null);
}));

function hostProvider(overrides: Partial<HostProviderQuota> & { providerId: string; kind: string; accountKey: string }): HostProviderQuota {
  return {
    planLabel: null,
    status: 'available',
    quotaStatus: 'available',
    sourceId: 'test',
    fetchedAt: '2026-11-27T07:59:00.000Z',
    windows: [{ id: '5h', label: '5h', remainingPct: 80, usedPct: 20, resetsAt: '2026-11-27T11:00:00.000Z', hint: 'normal' }],
    balances: [],
    payableCredit: false,
    allocationHint: 'normal',
    error: null,
    upstream: null,
    runningSessions: 0,
    quotaGateExcluded: false,
    minRemainingPct: 10,
    ...overrides,
  };
}

test('mergeFleetQuotas & collectFleetQuotas：按账号跨主机去重、汇总 supportedHosts（含不同 providerId）、显式报告离线或旧版主机', async () => {
  const miniData: LocalHostQuotas = {
    serverId: 'srv-mini',
    hostName: 'Mac mini',
    collectedAt: '2026-11-27T08:00:00.000Z',
    sessionsError: null,
    providers: [
      hostProvider({
        providerId: 'antigravity-2',
        kind: 'antigravity',
        accountKey: 'antigravity:b74db7ad00000001',
        runningSessions: 1,
        windows: [
          { id: 'gemini-5h', label: 'Gemini 5h', remainingPct: 87, usedPct: 13, resetsAt: '2026-11-27T09:00:00Z', hint: 'prefer' },
        ],
        allocationHint: 'prefer',
      }),
      hostProvider({
        providerId: 'glm-acp-agent',
        kind: 'glm',
        accountKey: 'glm:1111222233334444',
        planLabel: 'Coding Plan (MAX)',
        runningSessions: 2,
        windows: [{ id: 'effective', label: '5h', remainingPct: 58, usedPct: 42, resetsAt: '2026-11-27T11:00:00Z', hint: 'normal' }],
      }),
      hostProvider({
        providerId: 'claude-low',
        kind: 'claude',
        accountKey: 'claude:acc-low.org1',
        runningSessions: 0,
        windows: [{ id: 'five_hour', label: '5h', remainingPct: 6, usedPct: 94, resetsAt: '2026-11-27T08:30:00Z', hint: 'throttle' }],
        allocationHint: 'throttle',
      }),
    ],
  };

  const macbookData: LocalHostQuotas = {
    serverId: 'srv-mb',
    hostName: 'MacBook',
    collectedAt: '2026-11-27T08:00:01.000Z',
    sessionsError: null,
    providers: [
      // 与 Mac mini 的 antigravity-2 同账号，但本机 providerId 是 antigravity 且本机未读到额度报告
      hostProvider({
        providerId: 'antigravity',
        kind: 'antigravity',
        accountKey: 'antigravity:b74db7ad00000001',
        quotaStatus: 'unknown',
        sourceId: null,
        fetchedAt: null,
        windows: [],
        allocationHint: 'unknown',
        runningSessions: 0,
      }),
      // 与 Mac mini 同 GLM 账号，但 MacBook 上本地认证报错
      hostProvider({
        providerId: 'glm-acp-agent',
        kind: 'glm',
        accountKey: 'glm:1111222233334444',
        quotaStatus: 'error',
        windows: [],
        allocationHint: 'unknown',
        error: '账号额度请求被拒绝（HTTP 401）',
        runningSessions: 1,
      }),
    ],
  };

  const fleet = await collectFleetQuotas(
    {
      hosts: async () => [
        { id: 'srv-mini', name: 'Mac mini', online: true },
        { id: 'srv-mb', name: 'MacBook', online: true },
        { id: 'srv-off', name: '备用机', online: false },
        { id: 'srv-old', name: '旧插件机', online: true },
      ],
      selfId: () => 'srv-mini',
      local: async () => miniData,
      remote: async host => {
        if (host.id === 'srv-mb') return macbookData;
        throw new Error('RPC method not found: providers.quotas.local');
      },
    },
    { minRemainingPct: 10, concurrencyTarget: 3, now: () => NOW },
  );

  // 4 台主机状态全部显式返回
  assert.equal(fleet.hosts.length, 4);
  assert.equal(fleet.hosts.find(h => h.serverId === 'srv-off')?.error, '主机离线');
  assert.match(fleet.hosts.find(h => h.serverId === 'srv-old')?.error ?? '', /升级并重载/);

  // 5 条主机条目按真实账号去重为 3 个账号
  assert.equal(fleet.accounts.length, 3);

  // 第 1 条：prefer 的共享 Antigravity 账号，支持 MacBook（antigravity，0 running）和 Mac mini（antigravity-2，1 running）
  const agy = fleet.accounts[0]!;
  assert.equal(agy.accountKey, 'antigravity:b74db7ad00000001');
  assert.equal(agy.verdict, 'ok');
  assert.equal(agy.totalRunningSessions, 1);
  assert.deepEqual(
    agy.supportedHosts.map(h => ({ serverId: h.serverId, providerId: h.providerId, usable: h.usable })),
    [
      { serverId: 'srv-mb', providerId: 'antigravity', usable: true },
      { serverId: 'srv-mini', providerId: 'antigravity-2', usable: true },
    ],
  );

  // 第 2 条：共享 GLM 账号，总运行数 3（high），Mac mini 可用，MacBook 标为不可用并保留本机错误
  const glm = fleet.accounts[1]!;
  assert.equal(glm.accountKey, 'glm:1111222233334444');
  assert.equal(glm.verdict, 'ok');
  assert.equal(glm.totalRunningSessions, 3);
  assert.equal(glm.concurrencyLoad, 'high');
  assert.equal(glm.supportedHosts.find(h => h.serverId === 'srv-mini')?.usable, true);
  assert.equal(glm.supportedHosts.find(h => h.serverId === 'srv-mb')?.usable, false);
  assert.match(glm.supportedHosts.find(h => h.serverId === 'srv-mb')?.hostError ?? '', /HTTP 401/);

  // 第 3 条：剩 6% 的 Claude 低于 10% 阈值，判为 blocked 且主机均标为不可用
  const low = fleet.accounts[2]!;
  assert.equal(low.accountKey, 'claude:acc-low.org1');
  assert.equal(low.verdict, 'blocked');
  assert.equal(low.supportedHosts[0]?.usable, false);
  assert.ok(low.blockReasons.some(reason => reason.includes('低于 10%')));

  // kind 过滤
  const onlyGlm = mergeFleetQuotas(
    [{ serverId: 'srv-mini', hostName: 'Mac mini', isSelf: true, online: true, data: miniData, error: null }],
    { collectedAt: '2026-11-27T08:00:00.000Z', minRemainingPct: 10, concurrencyTarget: 3, kind: 'glm' },
  );
  assert.deepEqual(onlyGlm.accounts.map(a => a.kind), ['glm']);
});

test('quotaToolModule：注册本地/跨主机 RPC，并通过 agent.open.before 注入 provider_quotas 工具', async () => {
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const hooks = new Map<string, (event: { request: { purpose?: string; tools: Array<{ name: string; execute: (input: unknown) => Promise<unknown> }> } }) => Promise<{ purpose?: string; tools: Array<{ name: string; execute: (input: unknown) => Promise<unknown> }> }>>();
  let removed = false;

  const cleanup = await quotaToolModule.register({
    server: {
      handle(contract: { name: string }, fn: (input: unknown) => Promise<unknown>) { handlers.set(contract.name, fn); },
      addHook(name: string, fn: never) { hooks.set(name, fn); return () => { removed = true; }; },
    } as never,
    services: {
      home: '/tmp/nonexistent-paseo-home',
      daemon: {
        ready: async () => ({
          client: {
            getProvidersSnapshot: async () => ({ entries: [] }),
            listUsageReports: async () => ({ reports: [] }),
            fetchAgents: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }),
          },
        }),
      },
      main: {
        readyHosts: async () => ({
          selfId: () => 'srv-self',
          selfHost: async () => ({ id: 'srv-self', name: '本机', online: true }),
          hosts: async () => [{ id: 'srv-self', name: '本机', online: true }],
          invokePlugin: async () => { throw new Error('unexpected remote call'); },
        }),
      },
    } as never,
    machine: { path: '/tmp/nonexistent-machine.json' } as never,
    config: undefined,
  } as never);

  assert.ok(handlers.has('providers.quotas.local'));
  assert.ok(handlers.has('providers.quotas.fleet'));

  const openHook = hooks.get('agent.open.before')!;
  const historyReq = { purpose: 'history', tools: [] };
  assert.equal(await openHook({ request: historyReq }), historyReq);

  const liveReq = await openHook({ request: { tools: [] } });
  assert.deepEqual(liveReq.tools.map(t => t.name), ['provider_quotas']);
  // 重复经过钩子不重复注入
  const twice = await openHook({ request: liveReq });
  assert.equal(twice.tools.length, 1);

  const toolResult = await liveReq.tools[0]!.execute({}) as { text: string; structuredContent: { hosts: unknown[]; accounts: unknown[] } };
  assert.equal(toolResult.structuredContent.hosts.length, 1);
  assert.deepEqual(toolResult.structuredContent.accounts, []);
  assert.ok(toolResult.text.includes('srv-self'));

  await cleanup?.();
  assert.equal(removed, true);
});
