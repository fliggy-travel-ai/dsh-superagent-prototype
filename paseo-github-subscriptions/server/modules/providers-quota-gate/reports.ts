import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readJsonStrict } from '../../core/provider-config.ts';
import type { DaemonConnection } from '../../core/daemon.ts';
import { accountMap } from '../usage-claude-accounts/account-map.ts';
import { ContinuousUsage } from '../usage-claude-accounts/continuous-usage.ts';
import { allocationHint, quotaUnknown, quotaUsable, type AccountQuota } from './rules.ts';
import { proxyAccount, proxyQuotaUrl, readProxyQuotas } from './proxy.ts';

export type QuotaReportClient = Pick<DaemonConnection['client'], 'listUsageReports' | 'getProvidersSnapshot'>;
export type UsageReportEntry = Awaited<ReturnType<QuotaReportClient['listUsageReports']>>['reports'][number];

export interface ProviderConfig {
  enabled?: boolean;
  label?: string;
  extends?: string;
  command?: string[];
  env?: Record<string, string>;
}

export const directSources = new Map([
  ['codex-multi', 'codex'],
  ['antigravity-multi', 'antigravity'], ['glm', 'glm'], ['qoder', 'qoder'], ['opencode-token-switch', 'opencode'],
]);
export const builtinSources = new Set(['antigravity', 'codex', 'cursor', 'grok']);
const identityEnvKeys = ['HOME', 'CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'GROK_HOME', 'XDG_CONFIG_HOME', 'MAGPIE_URL'];

export function providerRoute(provider: string, providers: Record<string, ProviderConfig>) {
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
  if (command.some(part => /(?:^|\/)(?:@qoder-ai\/qodercli|qodercli)(?:@[^/]*)?$/.test(part))) kind = 'qoder';
  if (command.some(part => /^glm-acp-agent(?:@|$)/.test(part)) || provider === 'glm-acp-agent' || provider.startsWith('glm-')) kind = 'glm';
  if (command.some(part => /(?:^|\/)grok$/.test(part)) || provider === 'grok' || provider.startsWith('grok-')) kind = 'grok';
  if (command.some(part => /(?:^|\/)opencode$/.test(part)) || provider === 'opencode' || provider.startsWith('opencode-')) kind = 'opencode';
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const entry of entries) Object.assign(env, entry.env);
  return { kind, env, label: entries.findLast(entry => entry.label)?.label };
}

export function matchUsageReport(
  reports: readonly UsageReportEntry[],
  provider: string,
  kind: string,
  claudeKey: string | undefined,
): UsageReportEntry | undefined {
  const exact = reports.filter(entry => directSources.has(entry.sourceId) && entry.id === `${entry.sourceId}:${provider}`);
  const claude = claudeKey ? reports.filter(entry => ['claude-accounts', 'claude'].includes(entry.sourceId) && entry.id === `${entry.sourceId}:${claudeKey}`) : [];
  const builtin = builtinSources.has(provider) ? reports.filter(entry => entry.sourceId === provider) : [];
  const claudeFallback = !claudeKey && kind === 'claude' && provider === 'claude'
    ? (() => {
      const only = reports.filter(entry => entry.sourceId === 'claude');
      return only.length === 1 ? only : [];
    })()
    : [];
  const pool = exact.length ? exact : claude.length ? claude : builtin.length ? builtin : claudeFallback;
  return pool.reduce<UsageReportEntry | undefined>(
    (latest, entry) => !latest || Date.parse(entry.fetchedAt) > Date.parse(latest.fetchedAt) ? entry : latest,
    undefined,
  );
}

export function hasPayableCredit(resolvedKind: string, report: Extract<UsageReportEntry['report'], { status: 'available' }>): boolean {
  return resolvedKind === 'codex' && (
    report.balances?.some(balance => balance.id === 'credits' && (balance.remaining ?? 0) > 0) === true
    || report.details?.some(detail => detail.id === 'payable_credit' && detail.value === 'unlimited') === true
  );
}

export function quotaFromReports(reports: readonly UsageReportEntry[], provider: string, kind: string, claudeKey: string | undefined, now: number): AccountQuota | undefined {
  const best = matchUsageReport(reports, provider, kind, claudeKey);
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
    const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    // Antigravity 未消费满额分组会返回 1970-01-01T00:00:00Z 占位，不能当成已过期窗口丢弃。
    if (resetsAt > 0 && resetsAt <= now) return [];
    const remainingPct = window.remainingPct ?? (window.usedPct == null ? undefined : 100 - window.usedPct);
    return remainingPct === undefined ? [] : [{ id: window.id, label: window.shortLabel ?? window.label, remainingPct }];
  });
  const payableCredit = hasPayableCredit(resolvedKind, report);
  return { kind: resolvedKind, windows, payableCredit, allocationHint: allocationHint(windows, resolvedKind === 'cursor', payableCredit) };
}

export function localQuotaReader(client: QuotaReportClient, paseoHome: string, signal: AbortSignal) {
  const providers: Record<string, ProviderConfig> = readJsonStrict(join(paseoHome, 'config.json'))?.agents?.providers ?? {};
  const home = basename(paseoHome) === '.paseo' ? dirname(paseoHome) : homedir();
  const usageReports = client.listUsageReports().then(result => result.reports, () => []);
  const proxyReports = new Map<string, ReturnType<typeof readProxyQuotas>>();
  let claudeAccounts: ReturnType<typeof accountMap> | undefined;
  let claudeUsage: ContinuousUsage | undefined;

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
    if (route.kind === 'claude') {
      claudeUsage ??= new ContinuousUsage({ home: paseoHome, renewal: false });
      // 凭据被清空或过期且无法续期的账号不会出现在账号映射里，必须单独拦截，不能当作额度未知放行。
      // API Key、外部网关和独立系统用户的账号不在本机用户的钥匙串里，不做登录检查。
      const apiLogin = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'].some(key => route.env[key]);
      const configDir = route.env.CLAUDE_CONFIG_DIR;
      const ownLogin = !configDir || configDir.startsWith(`${home}/`);
      if (!apiLogin && ownLogin && await claudeUsage.needsLogin(route.env)) return { error: '账号未登录或登录已过期，请在对应账号的 Claude Code 终端重新登录' };
      if (reports.some(report => report.sourceId === 'claude-accounts' || report.sourceId === 'claude')) {
        claudeAccounts ??= accountMap(paseoHome, claudeUsage.discover);
      }
    }
    const claudeKey = route.kind === 'claude' ? (await claudeAccounts)?.get(provider) : undefined;
    return quotaFromReports(reports, provider, route.kind, claudeKey, Date.now());
  }

  async function alternatives(provider: string, floor: number): Promise<{ passing: string[]; unknown: string[] }> {
    const { entries, compactSnapshot } = await client.getProvidersSnapshot();
    const others = (compactSnapshot?.entries ?? entries).filter(entry =>
      entry.enabled && entry.status !== 'unavailable' && entry.status !== 'error' && entry.provider !== provider);
    const passing: string[] = [];
    const unknown: string[] = [];
    await Promise.all(others.map(async entry => {
      const quota = await read(entry.provider).catch(() => undefined);
      if (quotaUsable(quota, floor)) passing.push(entry.provider);
      else if (quotaUnknown(quota)) unknown.push(entry.provider);
    }));
    return {
      passing: [...new Set(passing)].sort(),
      unknown: [...new Set(unknown)].sort(),
    };
  }

  return { read, alternatives };
}
