import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { DaemonConnection } from '../../core/daemon.ts';
import { summarizeError } from '../../core/modules.ts';
import { readJsonStrict } from '../../core/provider-config.ts';
import {
  accountAllocationHint,
  windowPaceHint,
  type HostProviderQuota,
  type LocalHostQuotas,
  type QuotaBalanceReport,
  type QuotaWindowReport,
} from '../../../shared/provider-quota-tool.ts';
import { gateExcluded } from '../../../shared/quota-gate.ts';
import {
  directSources,
  hasPayableCredit,
  matchUsageReport,
  providerRoute,
  type ProviderConfig,
  type UsageReportEntry,
} from '../providers-quota-gate/reports.ts';
import { proxyDetails, proxyQuotaUrl, readProxyQuotas, type ProxyReport } from '../providers-quota-gate/proxy.ts';
import { accountMap } from '../usage-claude-accounts/account-map.ts';
import { ContinuousUsage } from '../usage-claude-accounts/continuous-usage.ts';
import { resolveAccountKey } from './identity.ts';

const POOLED_KINDS = new Set(['cursor', 'antigravity']);
const SKIPPED_PROVIDERS = new Set(['cloud-session']);

export interface LocalQuotaClient {
  listUsageReports: DaemonConnection['client']['listUsageReports'];
  getProvidersSnapshot: DaemonConnection['client']['getProvidersSnapshot'];
  fetchAgents(options: {
    filter?: { includeArchived?: boolean };
    page?: { limit?: number; cursor?: string };
    timeout?: number;
  }): Promise<{
    entries: Array<{ agent: { id: string; provider: string; status: string; archivedAt?: string | null } }>;
    pageInfo: { hasMore: boolean; nextCursor?: string | null };
  }>;
}

export interface CollectLocalQuotasInput {
  client: LocalQuotaClient;
  paseoHome: string;
  serverId: string;
  hostName: string;
  excludeProviders?: readonly string[];
  refresh?: boolean;
  now?: () => number;
  signal?: AbortSignal;
  /** 测试注入：覆盖 magpie 代理读取。 */
  readProxy?: (url: string, signal: AbortSignal) => Promise<ProxyReport | undefined>;
  /** 测试注入：覆盖本机 Claude 登录态与账号映射读取。 */
  claudeProbe?: {
    needsLogin: (env: NodeJS.ProcessEnv) => Promise<boolean>;
    accounts: () => Promise<Map<string, string>>;
  };
}

function roundPct(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
}

function normalizeResetsAt(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  // Antigravity 未消费满额分组可能返回 1970-01-01T00:00:00Z 占位时间。
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return raw;
}

function extractWindows(
  report: Extract<UsageReportEntry['report'], { status: 'available' }>,
  nowMs: number,
): QuotaWindowReport[] {
  const result: QuotaWindowReport[] = [];
  for (const window of report.windows) {
    const resetsAt = normalizeResetsAt(window.resetsAt);
    if (resetsAt !== null) {
      const resetMs = Date.parse(resetsAt);
      if (resetMs <= nowMs) continue;
    }
    const rawRemaining = window.remainingPct ?? (window.usedPct == null ? undefined : 100 - window.usedPct);
    if (typeof rawRemaining !== 'number' || !Number.isFinite(rawRemaining)) continue;
    const remainingPct = roundPct(rawRemaining);
    const usedPct = roundPct(100 - remainingPct);
    const label = (window.shortLabel ?? window.label ?? window.id).trim() || window.id;
    result.push({
      id: window.id,
      label,
      remainingPct,
      usedPct,
      resetsAt,
      hint: windowPaceHint(remainingPct, resetsAt, window.id, label, nowMs),
    });
  }
  return result;
}

function extractBalances(
  resolvedKind: string,
  report: Extract<UsageReportEntry['report'], { status: 'available' }>,
): QuotaBalanceReport[] {
  const unlimitedCodex = resolvedKind === 'codex'
    && report.details?.some(detail => detail.id === 'payable_credit' && detail.value === 'unlimited') === true;
  const balances: QuotaBalanceReport[] = (report.balances ?? []).map(balance => ({
    id: balance.id,
    label: balance.label,
    used: typeof balance.used === 'number' && Number.isFinite(balance.used) ? balance.used : null,
    remaining: typeof balance.remaining === 'number' && Number.isFinite(balance.remaining) ? balance.remaining : null,
    limit: typeof balance.limit === 'number' && Number.isFinite(balance.limit) ? balance.limit : null,
    unit: balance.unit ?? null,
    resetsAt: normalizeResetsAt(balance.resetsAt),
    extra: resolvedKind === 'codex' && balance.id === 'credits',
    unlimited: resolvedKind === 'codex' && balance.id === 'credits' && unlimitedCodex,
  }));
  if (unlimitedCodex && !balances.some(balance => balance.id === 'credits')) {
    balances.push({
      id: 'credits',
      label: 'Credits',
      used: null,
      remaining: null,
      limit: null,
      unit: 'credits',
      resetsAt: null,
      extra: true,
      unlimited: true,
    });
  }
  return balances;
}

async function countRunningSessions(
  client: LocalQuotaClient,
): Promise<{ counts: Map<string, number> | null; error: string | null }> {
  const counts = new Map<string, number>();
  let cursor: string | undefined;
  try {
    for (let page = 0; page < 100; page++) {
      const result = await client.fetchAgents({
        filter: { includeArchived: false },
        page: { limit: 100, cursor },
        timeout: 10_000,
      });
      for (const entry of result.entries) {
        if (entry.agent.archivedAt || entry.agent.status !== 'running') continue;
        const provider = entry.agent.provider;
        counts.set(provider, (counts.get(provider) ?? 0) + 1);
      }
      if (!result.pageInfo.hasMore) return { counts, error: null };
      if (!result.pageInfo.nextCursor || result.pageInfo.nextCursor === cursor) break;
      cursor = result.pageInfo.nextCursor;
    }
    return { counts: null, error: '会话清单分页未完整返回' };
  } catch (error) {
    return { counts: null, error: summarizeError(error) };
  }
}

/** 采集单台本机上全部已启用 Provider 的额度、代理池、运行中会话数及去重账号键。 */
export async function collectLocalQuotas(input: CollectLocalQuotasInput): Promise<LocalHostQuotas> {
  const nowMs = (input.now ?? Date.now)();
  const collectedAt = new Date(nowMs).toISOString();
  const signal = input.signal ?? AbortSignal.timeout(15_000);
  const excludeProviders = input.excludeProviders ?? [];
  const home = basename(input.paseoHome) === '.paseo' ? dirname(input.paseoHome) : homedir();
  const configuredProviders: Record<string, ProviderConfig> =
    readJsonStrict(join(input.paseoHome, 'config.json'))?.agents?.providers ?? {};

  const [snapshot, usageResult, sessions] = await Promise.all([
    input.client.getProvidersSnapshot(),
    input.client.listUsageReports(input.refresh ? { forceRefresh: true } : undefined).then(
      result => ({ reports: result.reports, error: null as string | null }),
      error => ({ reports: [] as UsageReportEntry[], error: summarizeError(error) }),
    ),
    countRunningSessions(input.client),
  ]);

  const rawEntries = snapshot.compactSnapshot?.entries ?? snapshot.entries;
  const byProvider = new Map(rawEntries.map(entry => [entry.provider, entry]));

  // 只纳入已启用且可用的 Provider，以及用户显式配置在 config.json 中的 Provider（避免列出未安装的内置项）。
  const activeProviders = [...byProvider.values()]
    .filter(entry => {
      if (entry.enabled === false) return false;
      if (SKIPPED_PROVIDERS.has(entry.provider)) return false;
      const explicitlyConfigured = Object.prototype.hasOwnProperty.call(configuredProviders, entry.provider)
        && configuredProviders[entry.provider]?.enabled !== false;
      if (entry.status === 'unavailable' && !explicitlyConfigured) return false;
      return true;
    })
    .sort((a, b) => a.provider.localeCompare(b.provider));

  const proxyReports = new Map<string, Promise<ProxyReport | undefined>>();
  const proxyReader = input.readProxy ?? readProxyQuotas;

  let claudeUsage: ContinuousUsage | undefined;
  let claudeAccountsPromise: Promise<Map<string, string>> | undefined;
  const getClaudeUsage = () => {
    claudeUsage ??= new ContinuousUsage({ home: input.paseoHome, renewal: false });
    return claudeUsage;
  };
  const getClaudeAccounts = () => {
    if (input.claudeProbe) return input.claudeProbe.accounts();
    claudeAccountsPromise ??= accountMap(input.paseoHome, getClaudeUsage().discover);
    return claudeAccountsPromise;
  };

  const providers: HostProviderQuota[] = await Promise.all(activeProviders.map(async entry => {
    const providerId = entry.provider;
    const route = providerRoute(providerId, configuredProviders);
    const label = configuredProviders[providerId]?.label ?? entry.label ?? undefined;
    const runningSessions = sessions.counts ? (sessions.counts.get(providerId) ?? 0) : null;
    const excluded = gateExcluded(excludeProviders, providerId);

    const url = proxyQuotaUrl(route.kind, route.env, home);
    if (url) {
      if (!proxyReports.has(url)) {
        proxyReports.set(url, proxyReader(url, AbortSignal.any([signal, AbortSignal.timeout(4000)])));
      }
      const proxy = await proxyReports.get(url);
      if (proxy) {
        const parsed = proxyDetails(proxy, providerId, route.kind);
        return {
          providerId,
          kind: route.kind,
          accountKey: resolveAccountKey({
            serverId: input.serverId,
            providerId,
            kind: route.kind,
            env: route.env,
            home,
            label,
            proxied: true,
          }),
          planLabel: null,
          status: entry.status,
          quotaStatus: parsed.error ? 'error' : 'proxied',
          sourceId: 'magpie',
          fetchedAt: collectedAt,
          windows: [],
          balances: [],
          payableCredit: false,
          allocationHint: parsed.allocationHint,
          error: null,
          upstream: { error: parsed.error, accounts: parsed.accounts },
          runningSessions,
          quotaGateExcluded: excluded,
        };
      }
    }

    let claudeKey: string | undefined;
    if (route.kind === 'claude') {
      const apiLogin = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'].some(key => route.env[key]);
      const configDir = route.env.CLAUDE_CONFIG_DIR;
      const ownLogin = !configDir || configDir.startsWith(`${home}/`);
      const needsLogin = !apiLogin && ownLogin
        ? await (input.claudeProbe
          ? input.claudeProbe.needsLogin(route.env)
          : getClaudeUsage().needsLogin(route.env)).catch(() => false)
        : false;
      if (needsLogin) {
        return {
          providerId,
          kind: 'claude',
          accountKey: resolveAccountKey({
            serverId: input.serverId,
            providerId,
            kind: 'claude',
            env: route.env,
            home,
            label,
          }),
          planLabel: null,
          status: entry.status,
          quotaStatus: 'error',
          sourceId: null,
          fetchedAt: collectedAt,
          windows: [],
          balances: [],
          payableCredit: false,
          allocationHint: 'unknown',
          error: '账号未登录或登录已过期，请在对应账号的 Claude Code 终端重新登录',
          upstream: null,
          runningSessions,
          quotaGateExcluded: excluded,
        };
      }
      if (usageResult.reports.some(report => report.sourceId === 'claude-accounts' || report.sourceId === 'claude')) {
        claudeKey = (await getClaudeAccounts().catch(() => new Map<string, string>())).get(providerId);
      }
    }

    const matched = matchUsageReport(usageResult.reports, providerId, route.kind, claudeKey);
    const resolvedKind = matched ? (directSources.get(matched.sourceId) ?? route.kind) : route.kind;
    const accountKey = resolveAccountKey({
      serverId: input.serverId,
      providerId,
      kind: resolvedKind,
      env: route.env,
      home,
      label,
      claudeKey,
      report: matched,
    });

    if (!matched) {
      return {
        providerId,
        kind: resolvedKind,
        accountKey,
        planLabel: null,
        status: entry.status,
        quotaStatus: usageResult.error ? 'error' : 'unknown',
        sourceId: null,
        fetchedAt: null,
        windows: [],
        balances: [],
        payableCredit: false,
        allocationHint: 'unknown',
        error: usageResult.error ? `读取本机额度失败：${usageResult.error}` : null,
        upstream: null,
        runningSessions,
        quotaGateExcluded: excluded,
      };
    }

    const report = matched.report;
    if (report.status === 'error') {
      return {
        providerId,
        kind: resolvedKind,
        accountKey,
        planLabel: null,
        status: entry.status,
        quotaStatus: 'error',
        sourceId: matched.sourceId,
        fetchedAt: matched.fetchedAt ?? null,
        windows: [],
        balances: [],
        payableCredit: false,
        allocationHint: 'unknown',
        error: '账号额度查询报错（account.error）',
        upstream: null,
        runningSessions,
        quotaGateExcluded: excluded,
      };
    }

    if (report.status === 'unavailable') {
      const error = report.problem.kind === 'expired'
        ? '账号登录已过期'
        : report.problem.kind === 'rejected'
          ? `账号额度请求被拒绝（HTTP ${report.problem.status}）`
          : null;
      return {
        providerId,
        kind: resolvedKind,
        accountKey,
        planLabel: null,
        status: entry.status,
        quotaStatus: error ? 'error' : 'unknown',
        sourceId: matched.sourceId,
        fetchedAt: matched.fetchedAt ?? null,
        windows: [],
        balances: [],
        payableCredit: false,
        allocationHint: 'unknown',
        error,
        upstream: null,
        runningSessions,
        quotaGateExcluded: excluded,
      };
    }

    const windows = extractWindows(report, nowMs);
    const balances = extractBalances(resolvedKind, report);
    const payableCredit = hasPayableCredit(resolvedKind, report);
    const hint = accountAllocationHint(windows, POOLED_KINDS.has(resolvedKind), payableCredit);

    return {
      providerId,
      kind: resolvedKind,
      accountKey,
      planLabel: report.planLabel?.trim() || null,
      status: entry.status,
      quotaStatus: 'available',
      sourceId: matched.sourceId,
      fetchedAt: matched.fetchedAt ?? null,
      windows,
      balances,
      payableCredit,
      allocationHint: hint,
      error: null,
      upstream: null,
      runningSessions,
      quotaGateExcluded: excluded,
    };
  }));

  return {
    serverId: input.serverId,
    hostName: input.hostName,
    collectedAt,
    sessionsError: sessions.error,
    providers,
  };
}
