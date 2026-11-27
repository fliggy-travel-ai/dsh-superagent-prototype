import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

export const QuotaPaceHintSchema = z.enum(['prefer', 'normal', 'throttle', 'avoid', 'unknown']);
export type QuotaPaceHint = z.infer<typeof QuotaPaceHintSchema>;

export const ConcurrencyLoadSchema = z.enum(['idle', 'busy', 'high', 'unknown']);
export type ConcurrencyLoad = z.infer<typeof ConcurrencyLoadSchema>;

export const QuotaVerdictSchema = z.enum(['ok', 'blocked', 'unknown']);
export type QuotaVerdict = z.infer<typeof QuotaVerdictSchema>;

export const QuotaStatusSchema = z.enum(['available', 'proxied', 'unknown', 'error']);
export type QuotaStatus = z.infer<typeof QuotaStatusSchema>;

export const QuotaWindowReportSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  remainingPct: z.number(),
  usedPct: z.number(),
  resetsAt: z.string().nullable(),
  hint: QuotaPaceHintSchema,
});
export type QuotaWindowReport = z.infer<typeof QuotaWindowReportSchema>;

export const QuotaBalanceReportSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  used: z.number().nullable(),
  remaining: z.number().nullable(),
  limit: z.number().nullable(),
  unit: z.string().nullable(),
  resetsAt: z.string().nullable(),
  extra: z.boolean(),
  unlimited: z.boolean(),
});
export type QuotaBalanceReport = z.infer<typeof QuotaBalanceReportSchema>;

export const UpstreamAccountSchema = z.strictObject({
  provider: z.string(),
  windows: z.array(QuotaWindowReportSchema),
  balance: z.string().nullable(),
  allocationHint: QuotaPaceHintSchema,
});
export type UpstreamAccount = z.infer<typeof UpstreamAccountSchema>;

export const UpstreamQuotaSchema = z.strictObject({
  error: z.string().nullable(),
  accounts: z.array(UpstreamAccountSchema),
});
export type UpstreamQuota = z.infer<typeof UpstreamQuotaSchema>;

export const HostProviderQuotaSchema = z.strictObject({
  providerId: z.string(),
  kind: z.string(),
  accountKey: z.string(),
  planLabel: z.string().nullable(),
  status: z.string(),
  quotaStatus: QuotaStatusSchema,
  sourceId: z.string().nullable(),
  fetchedAt: z.string().nullable(),
  windows: z.array(QuotaWindowReportSchema),
  balances: z.array(QuotaBalanceReportSchema),
  payableCredit: z.boolean(),
  allocationHint: QuotaPaceHintSchema,
  error: z.string().nullable(),
  upstream: UpstreamQuotaSchema.nullable(),
  runningSessions: z.number().int().nonnegative().nullable(),
  quotaGateExcluded: z.boolean(),
  minRemainingPct: z.number().min(0).max(100),
});
export type HostProviderQuota = z.infer<typeof HostProviderQuotaSchema>;

export const LocalHostQuotasSchema = z.strictObject({
  serverId: z.string(),
  hostName: z.string(),
  collectedAt: z.string(),
  sessionsError: z.string().nullable(),
  providers: z.array(HostProviderQuotaSchema),
});
export type LocalHostQuotas = z.infer<typeof LocalHostQuotasSchema>;

export const SupportedHostSchema = z.strictObject({
  serverId: z.string(),
  hostName: z.string(),
  isSelf: z.boolean(),
  providerId: z.string(),
  status: z.string(),
  runningSessions: z.number().int().nonnegative().nullable(),
  quotaGateExcluded: z.boolean(),
  usable: z.boolean(),
  hostError: z.string().nullable(),
});
export type SupportedHost = z.infer<typeof SupportedHostSchema>;

export const DeduplicatedAccountSchema = z.strictObject({
  accountKey: z.string(),
  kind: z.string(),
  planLabel: z.string().nullable(),
  quotaStatus: QuotaStatusSchema,
  sourceId: z.string().nullable(),
  fetchedAt: z.string().nullable(),
  windows: z.array(QuotaWindowReportSchema),
  lowestRemainingPct: z.number().nullable(),
  balances: z.array(QuotaBalanceReportSchema),
  payableCredit: z.boolean(),
  allocationHint: QuotaPaceHintSchema,
  verdict: QuotaVerdictSchema,
  blockReasons: z.array(z.string()),
  warnings: z.array(z.string()),
  error: z.string().nullable(),
  upstream: UpstreamQuotaSchema.nullable(),
  totalRunningSessions: z.number().int().nonnegative().nullable(),
  concurrencyLoad: ConcurrencyLoadSchema,
  supportedHosts: z.array(SupportedHostSchema),
});
export type DeduplicatedAccount = z.infer<typeof DeduplicatedAccountSchema>;

export const FleetHostStatusSchema = z.strictObject({
  serverId: z.string(),
  hostName: z.string(),
  isSelf: z.boolean(),
  online: z.boolean(),
  ok: z.boolean(),
  collectedAt: z.string().nullable(),
  providerCount: z.number().int().nonnegative(),
  error: z.string().nullable(),
  sessionsError: z.string().nullable(),
});
export type FleetHostStatus = z.infer<typeof FleetHostStatusSchema>;

export const FleetQuotasSchema = z.strictObject({
  collectedAt: z.string(),
  minRemainingPct: z.number().min(0).max(100),
  concurrencyTarget: z.number().int().min(1),
  hosts: z.array(FleetHostStatusSchema),
  accounts: z.array(DeduplicatedAccountSchema),
});
export type FleetQuotas = z.infer<typeof FleetQuotasSchema>;

export const LocalQuotasInputSchema = z.object({
  refresh: z.boolean().optional(),
});
export type LocalQuotasInput = z.infer<typeof LocalQuotasInputSchema>;

export const FleetQuotasInputSchema = z.object({
  kind: z.string().min(1).optional(),
  minRemainingPct: z.number().min(0).max(100).optional(),
  concurrencyTarget: z.number().int().min(1).max(100).optional(),
  refresh: z.boolean().optional(),
});
export type FleetQuotasInput = z.infer<typeof FleetQuotasInputSchema>;

export const localProviderQuotas = defineRpc({
  name: 'providers.quotas.local',
  input: LocalQuotasInputSchema,
  output: LocalHostQuotasSchema,
});

export const fleetProviderQuotas = defineRpc({
  name: 'providers.quotas.fleet',
  input: FleetQuotasInputSchema,
  output: FleetQuotasSchema,
});

const POOLED_KINDS = new Set(['cursor', 'antigravity']);
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

/** 按窗口标识或标签推断周期时长（毫秒），用于计算消耗节奏提示。 */
export function inferWindowPeriodMs(id: string, label: string): number | null {
  const text = `${id} ${label}`.toLowerCase();
  if (/(?:^|[\s_-])(?:5h|five_hour|5-hour|tokens_5h)(?:$|[\s_-])/.test(text)) return 5 * HOUR_MS;
  const hours = text.match(/(?:^|[\s_-])(?:tokens_)?(\d+)h(?:$|[\s_-])/);
  if (hours) {
    const count = Number(hours[1]);
    if (count > 0 && count <= 168) return count * HOUR_MS;
  }
  if (/(?:^|[\s_-])(?:7d|wk|weekly)(?:$|[\s_-])/.test(text)) return 7 * DAY_MS;
  if (/(?:^|[\s_-])(?:30d|mo|monthly|月|shared_credits|org_credits|user_credits)(?:$|[\s_-])/.test(text)) return 30 * DAY_MS;
  return null;
}

/** 按剩余比例和周期已过比例给出单窗口节奏提示。 */
export function windowPaceHint(
  remainingPct: number,
  resetsAt: string | null,
  id: string,
  label: string,
  nowMs: number,
): QuotaPaceHint {
  if (!Number.isFinite(remainingPct)) return 'unknown';
  if (remainingPct <= 0) return 'avoid';
  if (!resetsAt) return 'normal';
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs) || resetMs <= nowMs) return 'normal';
  const periodMs = inferWindowPeriodMs(id, label);
  if (!periodMs) return 'normal';
  const remainingTime = resetMs - nowMs;
  if (remainingTime > periodMs * 1.15) return 'normal';
  const elapsedShare = Math.max(0, Math.min(1, 1 - remainingTime / periodMs));
  const usedShare = Math.max(0, Math.min(1, (100 - remainingPct) / 100));
  if (elapsedShare >= 0.05 && usedShare <= elapsedShare - 0.1) return 'prefer';
  if (elapsedShare <= 0.95 && usedShare >= elapsedShare + 0.15 && remainingPct < 50) return 'throttle';
  return 'normal';
}

const HINT_BEST_RANK: Record<QuotaPaceHint, number> = {
  prefer: 0,
  normal: 1,
  throttle: 2,
  unknown: 3,
  avoid: 4,
};

const HINT_WORST_RANK: Record<QuotaPaceHint, number> = {
  avoid: 0,
  throttle: 1,
  normal: 2,
  prefer: 3,
  unknown: 4,
};

/** 合并同账号各窗口的节奏建议；分模型池取最佳窗口，共享窗口取最差窗口。 */
export function accountAllocationHint(
  windows: readonly Pick<QuotaWindowReport, 'remainingPct' | 'hint'>[],
  pooled: boolean,
  payableCredit: boolean,
): QuotaPaceHint {
  if (payableCredit) {
    return windows.some(window => window.hint === 'prefer') ? 'prefer' : 'normal';
  }
  if (windows.length === 0) return 'unknown';
  if (pooled) {
    return windows.reduce<QuotaPaceHint>(
      (best, window) => (HINT_BEST_RANK[window.hint] < HINT_BEST_RANK[best] ? window.hint : best),
      'avoid',
    );
  }
  const rated = windows.filter(window => window.hint !== 'unknown');
  if (rated.length === 0) return 'unknown';
  return rated.reduce<QuotaPaceHint>(
    (worst, window) => (HINT_WORST_RANK[window.hint] < HINT_WORST_RANK[worst] ? window.hint : worst),
    'prefer',
  );
}

export function concurrencyLoadFor(runningSessions: number | null, target: number): ConcurrencyLoad {
  if (runningSessions === null) return 'unknown';
  if (runningSessions <= 0) return 'idle';
  if (runningSessions < target) return 'busy';
  return 'high';
}

function formatWindowName(window: Pick<QuotaWindowReport, 'id' | 'label'>): string {
  const candidate = [window.label, window.id].find(value => value && /^[\w .:()\-\u4e00-\u9fff]{1,40}$/.test(value.trim()));
  return candidate?.trim() ?? '额度';
}

export function evaluateAccountVerdict(
  input: {
    kind: string;
    error: string | null;
    upstream: UpstreamQuota | null;
    allocationHint: QuotaPaceHint;
    windows: readonly QuotaWindowReport[];
    payableCredit: boolean;
    totalRunningSessions: number | null;
    concurrencyLoad: ConcurrencyLoad;
  },
  minRemainingPct: number,
): { verdict: QuotaVerdict; blockReasons: string[]; warnings: string[] } {
  const blockReasons: string[] = [];
  if (input.error) blockReasons.push(input.error);
  if (input.upstream?.error) blockReasons.push(input.upstream.error);
  const pooled = POOLED_KINDS.has(input.kind);
  if (input.allocationHint === 'avoid') {
    blockReasons.push('额度已耗尽（allocationHint avoid）');
    for (const window of input.windows) {
      if (window.remainingPct <= 0) {
        blockReasons.push(`${formatWindowName(window)} 窗口剩余 ${window.remainingPct}%`);
      }
    }
  } else if (!pooled && !input.payableCredit) {
    for (const window of input.windows) {
      if (window.remainingPct < minRemainingPct) {
        blockReasons.push(`${formatWindowName(window)} 窗口剩余 ${window.remainingPct}%（低于 ${minRemainingPct}%）`);
      }
    }
  }

  const warnings: string[] = [];
  if (input.allocationHint === 'throttle') warnings.push('消耗偏快（throttle）');
  if (input.concurrencyLoad === 'high') {
    warnings.push(`并发负载高（${input.totalRunningSessions} 个运行中会话）`);
  }

  const verdict: QuotaVerdict = blockReasons.length > 0
    ? 'blocked'
    : input.allocationHint === 'unknown'
      ? 'unknown'
      : 'ok';
  return { verdict, blockReasons, warnings };
}

export interface HostCollectionInput {
  serverId: string;
  hostName: string;
  isSelf: boolean;
  online: boolean;
  data: LocalHostQuotas | null;
  error: string | null;
}

const SOURCE_QUALITY: Record<QuotaStatus, number> = {
  available: 3,
  proxied: 2,
  unknown: 1,
  error: 0,
};

function compareSourceQuality(
  left: { provider: HostProviderQuota; isSelf: boolean; serverId: string },
  right: { provider: HostProviderQuota; isSelf: boolean; serverId: string },
): number {
  const leftScore = SOURCE_QUALITY[left.provider.quotaStatus] + (left.provider.windows.length > 0 ? 1 : 0);
  const rightScore = SOURCE_QUALITY[right.provider.quotaStatus] + (right.provider.windows.length > 0 ? 1 : 0);
  if (leftScore !== rightScore) return rightScore - leftScore;
  const leftAt = left.provider.fetchedAt ? Date.parse(left.provider.fetchedAt) : 0;
  const rightAt = right.provider.fetchedAt ? Date.parse(right.provider.fetchedAt) : 0;
  if (leftAt !== rightAt) return rightAt - leftAt;
  if (left.isSelf !== right.isSelf) return left.isSelf ? -1 : 1;
  return left.serverId.localeCompare(right.serverId);
}

const VERDICT_ORDER: Record<QuotaVerdict, number> = { ok: 0, unknown: 1, blocked: 2 };

/**
 * 合并多台主机的 Provider 额度，按底层账号键 `accountKey` 去重，并在 `supportedHosts` 列出每台支持主机的精确 `providerId`。
 */
export function mergeFleetQuotas(
  collected: readonly HostCollectionInput[],
  options: {
    collectedAt: string;
    minRemainingPct: number;
    concurrencyTarget: number;
    kind?: string;
  },
): FleetQuotas {
  const hosts: FleetHostStatus[] = collected.map(host => ({
    serverId: host.serverId,
    hostName: host.hostName,
    isSelf: host.isSelf,
    online: host.online,
    ok: host.error === null && host.data !== null,
    collectedAt: host.data?.collectedAt ?? null,
    providerCount: host.data?.providers.length ?? 0,
    error: host.error,
    sessionsError: host.data?.sessionsError ?? null,
  }));

  type Member = {
    serverId: string;
    hostName: string;
    isSelf: boolean;
    provider: HostProviderQuota;
  };
  const groups = new Map<string, Member[]>();
  const kindFilter = options.kind?.trim().toLowerCase();

  for (const host of collected) {
    if (!host.data) continue;
    for (const provider of host.data.providers) {
      if (kindFilter && provider.kind.toLowerCase() !== kindFilter) continue;
      const bucket = groups.get(provider.accountKey) ?? [];
      bucket.push({
        serverId: host.serverId,
        hostName: host.hostName,
        isSelf: host.isSelf,
        provider,
      });
      groups.set(provider.accountKey, bucket);
    }
  }

  const accounts: DeduplicatedAccount[] = [];
  for (const [accountKey, members] of groups) {
    const sortedMembers = [...members].sort(compareSourceQuality);
    const primary = sortedMembers[0]!.provider;
    const planLabel = sortedMembers.map(member => member.provider.planLabel).find(Boolean) ?? null;

    const sessionCounts = members.map(member => member.provider.runningSessions);
    const totalRunningSessions = sessionCounts.every((value): value is number => value !== null)
      ? sessionCounts.reduce((sum, value) => sum + value, 0)
      : null;
    const concurrencyLoad = concurrencyLoadFor(totalRunningSessions, options.concurrencyTarget);

    const lowestRemainingPct = primary.windows.length > 0
      ? Math.min(...primary.windows.map(window => window.remainingPct))
      : null;

    const evaluated = evaluateAccountVerdict(
      {
        kind: primary.kind,
        error: primary.error,
        upstream: primary.upstream,
        allocationHint: primary.allocationHint,
        windows: primary.windows,
        payableCredit: primary.payableCredit,
        totalRunningSessions,
        concurrencyLoad,
      },
      options.minRemainingPct,
    );

    const supportedHosts: SupportedHost[] = members
      .map(member => {
        const provider = member.provider;
        const statusBad = provider.status === 'unavailable' || provider.status === 'error';
        const hostQuotaError = provider.error ?? provider.upstream?.error ?? null;
        const hostError = statusBad
          ? `Provider 状态为 ${provider.status}`
          : hostQuotaError;
        const usable = !statusBad && hostQuotaError === null && evaluated.verdict !== 'blocked';
        return {
          serverId: member.serverId,
          hostName: member.hostName,
          isSelf: member.isSelf,
          providerId: provider.providerId,
          status: provider.status,
          runningSessions: provider.runningSessions,
          quotaGateExcluded: provider.quotaGateExcluded,
          usable,
          hostError,
        };
      })
      .sort((a, b) => {
        if (a.usable !== b.usable) return a.usable ? -1 : 1;
        const aLoad = a.runningSessions ?? Number.MAX_SAFE_INTEGER;
        const bLoad = b.runningSessions ?? Number.MAX_SAFE_INTEGER;
        if (aLoad !== bLoad) return aLoad - bLoad;
        if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
        return a.serverId.localeCompare(b.serverId) || a.providerId.localeCompare(b.providerId);
      });

    accounts.push({
      accountKey,
      kind: primary.kind,
      planLabel,
      quotaStatus: primary.quotaStatus,
      sourceId: primary.sourceId,
      fetchedAt: primary.fetchedAt,
      windows: primary.windows,
      lowestRemainingPct,
      balances: primary.balances,
      payableCredit: primary.payableCredit,
      allocationHint: primary.allocationHint,
      verdict: evaluated.verdict,
      blockReasons: evaluated.blockReasons,
      warnings: evaluated.warnings,
      error: primary.error,
      upstream: primary.upstream,
      totalRunningSessions,
      concurrencyLoad,
      supportedHosts,
    });
  }

  accounts.sort((a, b) => {
    if (VERDICT_ORDER[a.verdict] !== VERDICT_ORDER[b.verdict]) {
      return VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict];
    }
    const aHasUsable = a.supportedHosts.some(host => host.usable);
    const bHasUsable = b.supportedHosts.some(host => host.usable);
    if (aHasUsable !== bHasUsable) return aHasUsable ? -1 : 1;
    if (HINT_BEST_RANK[a.allocationHint] !== HINT_BEST_RANK[b.allocationHint]) {
      return HINT_BEST_RANK[a.allocationHint] - HINT_BEST_RANK[b.allocationHint];
    }
    const aLow = a.lowestRemainingPct ?? -1;
    const bLow = b.lowestRemainingPct ?? -1;
    if (aLow !== bLow) return bLow - aLow;
    const aLoad = a.totalRunningSessions ?? Number.MAX_SAFE_INTEGER;
    const bLoad = b.totalRunningSessions ?? Number.MAX_SAFE_INTEGER;
    if (aLoad !== bLoad) return aLoad - bLoad;
    return a.kind.localeCompare(b.kind) || a.accountKey.localeCompare(b.accountKey);
  });

  return {
    collectedAt: options.collectedAt,
    minRemainingPct: options.minRemainingPct,
    concurrencyTarget: options.concurrencyTarget,
    hosts,
    accounts,
  };
}
