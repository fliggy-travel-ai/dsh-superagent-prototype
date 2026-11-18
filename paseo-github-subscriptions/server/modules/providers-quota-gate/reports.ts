import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readJsonStrict } from '../../core/provider-config.ts';
import type { DaemonConnection } from '../../core/daemon.ts';
import { accountMap } from '../usage-claude-accounts/account-map.ts';
import { ContinuousUsage } from '../usage-claude-accounts/continuous-usage.ts';
import { allocationHint, quotaUsable, type AccountQuota } from './rules.ts';
import { proxyAccount, proxyQuotaUrl, readProxyQuotas } from './proxy.ts';

type Client = Pick<DaemonConnection['client'], 'listUsageReports' | 'getProvidersSnapshot'>;
type UsageReportEntry = Awaited<ReturnType<Client['listUsageReports']>>['reports'][number];

interface ProviderConfig {
  extends?: string;
  command?: string[];
  env?: Record<string, string>;
}

const directSources = new Map([
  ['codex-multi', 'codex'], ['cursor-cli', 'cursor'], ['grok-multi', 'grok'],
  ['antigravity', 'antigravity'], ['glm', 'glm'], ['qoder', 'qoder'], ['opencode-token-switch', 'opencode'],
]);
const builtinSources = new Set(['codex', 'cursor', 'grok']);
const identityEnvKeys = ['HOME', 'CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'GROK_HOME', 'XDG_CONFIG_HOME', 'MAGPIE_URL'];

function providerRoute(provider: string, providers: Record<string, ProviderConfig>) {
  const chain = new Set<string>();
  const entries: ProviderConfig[] = [];
  let name: string | undefined = provider;
  while (name && !chain.has(name)) {
    chain.add(name);
    const entry: ProviderConfig = providers[name] ?? {};
    entries.unshift(entry);
    name = entry.extends;
  }
  const command = entries.findLast(entry => entry.command)?.command ?? [];
  let kind = [...chain].at(-1) ?? provider;
  if (command.some(part => /(?:^|\/)cursor-agent(?:-[^/]+)?$/.test(part))) kind = 'cursor';
  if (command.some(part => /(?:^|\/)agy(?:-paseo(?:-[^/]+)?)?$/.test(part))) kind = 'antigravity';
  if (command.some(part => /(?:^|\/)pi$/.test(part))) kind = 'pi';
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const entry of entries) Object.assign(env, entry.env);
  return { kind, env };
}

export function quotaFromReports(reports: readonly UsageReportEntry[], provider: string, kind: string, claudeKey: string | undefined, now: number): AccountQuota | undefined {
  const exact = reports.filter(entry => directSources.has(entry.sourceId) && entry.id === `${entry.sourceId}:${provider}`);
  const claude = claudeKey ? reports.filter(entry => ['claude-accounts', 'claude'].includes(entry.sourceId) && entry.id === `${entry.sourceId}:${claudeKey}`) : [];
  const builtin = builtinSources.has(provider) ? reports.filter(entry => entry.sourceId === provider) : [];
  const best = (exact.length ? exact : claude.length ? claude : builtin)
    .reduce<UsageReportEntry | undefined>((latest, entry) => !latest || Date.parse(entry.fetchedAt) > Date.parse(latest.fetchedAt) ? entry : latest, undefined);
  if (!best) return;
  const report = best.report;
  if (report.status === 'error') return { error: '账号额度查询报错（account.error）' };
  if (report.status === 'unavailable') {
    if (report.problem.kind === 'expired') return { error: '账号登录已过期' };
    if (report.problem.kind === 'rejected') return { error: `账号额度请求被拒绝（HTTP ${report.problem.status}）` };
    return;
  }
  const resolvedKind = directSources.get(best.sourceId) ?? kind;
  const windows = report.windows.flatMap(window => {
    if (window.resetsAt && Date.parse(window.resetsAt) <= now) return [];
    const remainingPct = window.remainingPct ?? (window.usedPct == null ? undefined : 100 - window.usedPct);
    return remainingPct === undefined ? [] : [{ id: window.id, remainingPct }];
  });
  const payableCredit = resolvedKind === 'codex' && (
    report.balances?.some(balance => balance.id === 'credits' && (balance.remaining ?? 0) > 0) === true
    || report.details?.some(detail => detail.id === 'payable_credit' && detail.value === 'unlimited') === true
  );
  return { kind: resolvedKind, windows, payableCredit, allocationHint: allocationHint(windows, resolvedKind === 'cursor', payableCredit) };
}

export function localQuotaReader(client: Client, paseoHome: string, signal: AbortSignal) {
  const providers: Record<string, ProviderConfig> = readJsonStrict(join(paseoHome, 'config.json'))?.agents?.providers ?? {};
  const home = basename(paseoHome) === '.paseo' ? dirname(paseoHome) : homedir();
  const usageReports = client.listUsageReports().then(result => result.reports, () => []);
  const proxyReports = new Map<string, ReturnType<typeof readProxyQuotas>>();
  let claudeAccounts: ReturnType<typeof accountMap> | undefined;

  async function read(provider: string, overrides?: Record<string, string>) {
    const route = providerRoute(provider, providers);
    const url = proxyQuotaUrl(route.kind, { ...route.env, ...overrides }, home);
    if (url) {
      if (!proxyReports.has(url)) proxyReports.set(url, readProxyQuotas(url, AbortSignal.any([signal, AbortSignal.timeout(4000)])));
      const proxy = await proxyReports.get(url);
      if (proxy) return proxyAccount(proxy, provider, route.kind);
    }
    if (identityEnvKeys.some(key => overrides?.[key] !== undefined && overrides[key] !== route.env[key])) return;
    const reports = await usageReports;
    if (route.kind === 'claude' && reports.some(report => report.sourceId === 'claude-accounts' || report.sourceId === 'claude')) {
      claudeAccounts ??= accountMap(paseoHome, new ContinuousUsage({ home: paseoHome, renewal: false }).discover);
    }
    const claudeKey = route.kind === 'claude' ? (await claudeAccounts)?.get(provider) : undefined;
    return quotaFromReports(reports, provider, route.kind, claudeKey, Date.now());
  }

  async function alternatives(provider: string, floor: number) {
    const { entries, compactSnapshot } = await client.getProvidersSnapshot();
    const others = (compactSnapshot?.entries ?? entries).filter(entry =>
      entry.enabled && entry.status !== 'unavailable' && entry.status !== 'error' && entry.provider !== provider);
    const results = await Promise.all(others.map(async entry => {
      const quota = await read(entry.provider).catch(() => undefined);
      return quotaUsable(quota, floor) ? entry.provider : null;
    }));
    return [...new Set(results.flatMap(result => result === null ? [] : [result]))].sort();
  }

  return { read, alternatives };
}
