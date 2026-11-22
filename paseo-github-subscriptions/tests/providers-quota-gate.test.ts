import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadMachineConfig } from '../server/core/machine-config.ts';
import { quotaGateModule } from '../server/modules/providers-quota-gate/index.ts';
import { proxyAccount, proxyQuotaUrl, readProxyQuotas } from '../server/modules/providers-quota-gate/proxy.ts';
import { quotaFromReports } from '../server/modules/providers-quota-gate/reports.ts';
import { localQuotaReader } from '../server/modules/providers-quota-gate/reports.ts';
import { quotaProblems, quotaUsable, quotaWarnings } from '../server/modules/providers-quota-gate/rules.ts';

type UsageEntry = Parameters<typeof quotaFromReports>[0][number];
const window = (remainingPct: number) => ({ id: 'weekly', label: 'Weekly', remainingPct });
const usage = (sourceId: string, key: string, report: UsageEntry['report']): UsageEntry => ({
  sourceId, sourceLabel: sourceId, id: `${sourceId}:${key}`, fetchedAt: new Date().toISOString(), account: {}, report,
});
const available = (...windows: ReturnType<typeof window>[]): UsageEntry['report'] => ({ status: 'available', windows });

test('低于阈值只警告不拒绝，已耗尽、账号报错和代理报错拒绝', () => {
  assert.equal(quotaUsable({ allocationHint: 'normal', windows: [window(10)] }, 10), true);
  const low = { allocationHint: 'normal' as const, windows: [window(9.9)] };
  assert.deepEqual(quotaProblems(low), []);
  assert.match(quotaWarnings(low, 10)[0]!, /9\.9%/);
  assert.equal(quotaUsable(low, 10), false);
  assert.equal(quotaUsable({ allocationHint: 'unknown' }, 10), false);
  assert.match(quotaProblems({ allocationHint: 'avoid', windows: [window(0)] }).join(' '), /0%/);
  assert.deepEqual(quotaProblems({ error: '账号报错', upstream: { error: '上游报错' }, payableCredit: true }), ['账号报错', '上游报错']);
});

test('提示文案显示原窗口名，不显示 effective', () => {
  const pinned = usage('glm', 'glm-acp', available({ id: 'effective', label: 'Weekly limit', shortLabel: '7d', remainingPct: 8 } as never));
  assert.deepEqual(quotaWarnings(quotaFromReports([pinned], 'glm-acp', 'glm', undefined, 0), 10), ['7d 窗口剩余 8%']);
});

test('本机用户的 Claude 账号凭据缺失时拒绝，独立系统用户的账号不判定', async context => {
  const base = mkdtempSync(join(tmpdir(), 'quota-claude-'));
  context.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, '.paseo');
  mkdirSync(home);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ agents: { providers: {
    'claude-gone': { extends: 'claude', env: { CLAUDE_CONFIG_DIR: join(base, '.claude-gone') } },
    'claude-other-user': { extends: 'claude', env: { CLAUDE_CONFIG_DIR: '/Users/someone-else/.claude' } },
  } } }));
  const client = { listUsageReports: async () => ({ reports: [] }), getProvidersSnapshot: async () => ({ entries: [] }) };
  const reader = localQuotaReader(client as never, home, new AbortController().signal);
  assert.match(quotaProblems(await reader.read('claude-gone'))[0]!, /未登录或登录已过期/);
  assert.equal(await reader.read('claude-other-user'), undefined);
});

test('Cursor 有其他可用池即放行，Antigravity 跳过阈值但拒绝 avoid', () => {
  const quotas = [usage('cursor-cli', 'cursor-isolated', available(window(0), window(2))),
    usage('antigravity-multi', 'agy-isolated', available(window(2))), usage('antigravity-multi', 'agy-exhausted', available(window(0)))];
  assert.equal(quotaUsable(quotaFromReports(quotas, 'cursor-isolated', 'cursor', undefined, 0), 10), true);
  assert.equal(quotaUsable(quotaFromReports(quotas, 'agy-isolated', 'antigravity', undefined, 0), 10), true);
  assert.deepEqual(quotaProblems(quotaFromReports(quotas, 'agy-exhausted', 'antigravity', undefined, 0)), [
    '额度已耗尽（allocationHint avoid）', 'Weekly 窗口剩余 0%',
  ]);
});

test('只读目标账户，新快照的账号错误覆盖历史额度，付费余额与无限额度放行', () => {
  const stale = usage('codex', 'default', available(window(100)));
  const exact = usage('codex-multi', 'codex', { status: 'error', error: '敏感错误原文' });
  assert.match(quotaProblems(quotaFromReports([stale, exact], 'codex', 'codex', undefined, 0))[0]!, /account\.error/);
  assert.equal(quotaFromReports([stale, exact], 'codex-other', 'codex', undefined, 0), undefined);
  const paid = usage('codex-multi', 'codex-paid', {
    status: 'available', windows: [window(0)], balances: [{ id: 'credits', label: 'Credits', unit: 'usd', remaining: 1 }],
  });
  assert.equal(quotaUsable(quotaFromReports([paid], 'codex-paid', 'codex', undefined, 0), 10), true);
  const unlimited = usage('codex-multi', 'codex-unlimited', {
    status: 'available', windows: [window(0)], details: [{ id: 'payable_credit', label: 'Credits', value: 'unlimited' }],
  });
  assert.equal(quotaUsable(quotaFromReports([unlimited], 'codex-unlimited', 'codex', undefined, 0), 10), true);
  const expired = usage('claude-accounts', 'key', {
    status: 'available', windows: [{ ...window(0), resetsAt: '2026-01-01T00:00:00Z' }],
  });
  const rated = quotaFromReports([expired], 'claude-isolated', 'claude', 'key', Date.parse('2026-01-02T00:00:00Z'));
  assert.equal(rated?.allocationHint, 'unknown');
});

test('代理只查本机、不跟随重定向，按代理账户池评估且不上溯低额度阈值', async () => {
  const signal = new AbortController().signal;
  assert.equal(proxyQuotaUrl('codex', { OPENAI_BASE_URL: 'http://127.0.0.1:4040/path/v1' }, '/unused'), 'http://127.0.0.1:4040/path/v1/magpie/quotas');
  assert.equal(proxyQuotaUrl('codex', { OPENAI_BASE_URL: 'https://example.com/v1' }, '/unused'), undefined);
  const report = await readProxyQuotas('http://127.0.0.1:4040/v1/magpie/quotas', signal, async (_url, init) => {
    assert.equal(init?.redirect, 'error');
    return Response.json({ data: [
      { provider: 'grok', windows: [{ remaining: 0 }, { name: 'Total', remaining: 60 }] },
      { provider: 'codex', windows: [{ remaining: '0%' }] },
      { provider: 'codex', windows: [{ remaining: 2 }] },
      { provider: 'cursor', windows: [{ used: 100 }], balance: '$5.00' },
    ] });
  });
  assert.ok(report);
  assert.equal(quotaUsable(proxyAccount(report, 'codex-proxy', 'codex'), 10), true);
  assert.equal(quotaUsable(proxyAccount(report, 'cursor-proxy', 'cursor'), 10), true);
  assert.match(quotaProblems(proxyAccount(report, 'grok-proxy', 'grok'))[0]!, /avoid/);
  const failed = await readProxyQuotas('http://127.0.0.1:4040/v1/magpie/quotas', signal, async () => { throw new Error('受保护的报错'); });
  assert.ok(failed);
  assert.match(quotaProblems(proxyAccount(failed, 'grok', 'grok'))[0]!, /upstream\.error/);
});

test('创建钩子拒绝耗尽账号，只列本机启用且额度通过的账号，低额度和未知记录警告后放行', async context => {
  const home = mkdtempSync(join(tmpdir(), 'quota-gate-'));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, 'config.json'), '{}');
  let hook: ((input: { request: { config: { cwd: string; provider: string } } }) => Promise<unknown>) | undefined;
  const client = {
    listUsageReports: async () => ({ reports: [
      usage('codex-multi', 'codex-empty', available(window(0))),
      usage('codex-multi', 'codex-spare', available(window(12))),
      usage('codex-multi', 'codex-low', available(window(8))),
      usage('codex-multi', 'codex-disabled', available(window(50))),
    ] }),
    getProvidersSnapshot: async () => ({ entries: ['codex-empty', 'codex-spare', 'codex-low', 'codex-disabled', 'codex-unknown'].map(provider => ({
      provider, enabled: provider !== 'codex-disabled', status: 'loading',
    })) }),
  };
  quotaGateModule.register({
    server: { addHook: (name: string, handler: typeof hook) => { assert.equal(name, 'agent.create.before'); hook = handler; return () => {}; } },
    services: { home, daemon: { ready: async () => ({ client }) } },
    config: quotaGateModule.config!.spec.fallback,
  } as Parameters<typeof quotaGateModule.register>[0]);
  assert.ok(hook);
  const request = { config: { cwd: home, provider: 'codex-empty' } };
  await assert.rejects(hook({ request }), /codex-empty.*0%.*本机额度可用账号：codex-spare$/);
  const passing = { config: { cwd: home, provider: 'codex-spare' } };
  assert.equal(await hook({ request: passing }), passing);
  const warn = context.mock.method(console, 'warn', () => {});
  const low = { config: { cwd: home, provider: 'codex-low' } };
  assert.equal(await hook({ request: low }), low);
  assert.match(String(warn.mock.calls[0]?.arguments[0]), /codex-low.*低于 10%.*Weekly 窗口剩余 8%/);
  const unknown = { config: { cwd: home, provider: 'codex-unknown' } };
  assert.equal(await hook({ request: unknown }), unknown);
  assert.match(String(warn.mock.calls[1]?.arguments[0]), /codex-unknown.*额度未知/);
});

test('机器配置默认阈值、显式覆盖和非法值校验', () => {
  const sections = { quotaGate: quotaGateModule.config!.spec };
  assert.deepEqual(loadMachineConfig('unused', sections, () => '{"version":1}').section('quotaGate'), { ok: true, value: { minRemainingPct: 10 } });
  assert.deepEqual(loadMachineConfig('unused', sections, () => '{"version":1,"quotaGate":{"minRemainingPct":0}}').section('quotaGate'), { ok: true, value: { minRemainingPct: 0 } });
  assert.equal(loadMachineConfig('unused', sections, () => '{"version":1,"quotaGate":{"minRemainingPct":101}}').section('quotaGate').ok, false);
});
