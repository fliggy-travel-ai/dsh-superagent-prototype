// Provider display names carry the Claude quota or weekly reset countdown, so the agent picker shows it.
// Paseo has no plugin slot in that picker; the display name is the only text it shows per account.

type Window = { id?: string; usedPct?: number | null; remainingPct?: number | null; resetsAt?: string | null };
export type Report = { id?: string; sourceId?: string; report?: { status?: string; windows?: Window[] }; lastSuccessful?: { fetchedAt: string; report: { status?: string; windows?: Window[] } } };
export type Quota = { remainingPct: number; weeklyResetAt: number | null; historical?: boolean };
type ProviderConfig = { label?: unknown };

// "claude" is Paseo's bundled source (default login); "claude-accounts" is this module's default source ID.
export const DEFAULT_CLAUDE_SOURCES: ReadonlySet<string> = new Set(["claude", "claude-accounts"]);
const QUOTA_WINDOWS = new Set(["five_hour", "weekly"]);
const HEAD = "Claude · ";
// The quota goes after the leading "Claude · " so the account name stays last.
const QUOTA = /^(Claude · )?(?:(?:上次)?剩 \d+%|重置剩余 \d+d\d+h\d+m) · /;
// Earlier versions put the quota before or after the whole name; remove it so those names migrate.
const OLD_PREFIX = /^剩 \d+%｜/;
const OLD_SUFFIX = /｜剩 \d+%$/;

/** The display name without the quota that this plugin added. */
export function baseLabel(label: string): string {
  return label.replace(QUOTA, "$1").replace(OLD_PREFIX, "").replace(OLD_SUFFIX, "");
}

/** Days, hours, and minutes until reset; any partial minute counts as one minute. */
function resetCountdown(resetAt: number, now: number): string {
  const minutes = Math.max(0, Math.ceil((resetAt - now) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return `${days}d${hours}h${minutes % 60}m`;
}

/** Replaces the plugin's quota text while preserving the provider and account names. */
export function withQuota(label: string, value: Quota | null, now = Date.now()): string {
  const base = baseLabel(label);
  if (value === null) return base;
  const quota = value.weeklyResetAt === null
    ? `${value.historical ? "上次剩" : "剩"} ${value.remainingPct}% · `
    : `重置剩余 ${resetCountdown(value.weeklyResetAt, now)} · `;
  return base.startsWith(HEAD) ? HEAD + quota + base.slice(HEAD.length) : quota + base;
}

/** The smaller remaining percentage, plus the reset time when the weekly quota is exhausted. */
export function accountQuota(reports: Report[], accountKey: string, now = Date.now(), sources: ReadonlySet<string> = DEFAULT_CLAUDE_SOURCES): Quota | null {
  const matches = reports.filter(r => sources.has(r.sourceId ?? "") && r.id === `${r.sourceId}:${accountKey}`);
  const match = matches.find(r => r.report?.status === "available") ?? matches.find(r => r.lastSuccessful);
  const historical = match?.report?.status !== "available";
  const at = Date.parse(match?.lastSuccessful?.fetchedAt ?? "");
  if (historical && (!Number.isFinite(at) || at > now || now - at > 24 * 60 * 60_000)) return null;
  const windows = historical ? match?.lastSuccessful?.report.windows : match?.report?.windows;
  let lowest: number | null = null;
  let weeklyResetAt: number | null = null;
  for (const w of windows ?? []) {
    if (!QUOTA_WINDOWS.has(w.id ?? "")) continue;
    if (historical && !(Date.parse(w.resetsAt ?? "") > now)) continue;
    const left = w.remainingPct ?? (w.usedPct == null ? null : 100 - w.usedPct);
    if (left == null || !Number.isFinite(left)) continue;
    const pct = Math.min(100, Math.max(0, Math.round(left)));
    lowest = lowest === null ? pct : Math.min(lowest, pct);
    if (w.id === "weekly" && left <= 0) {
      const resetAt = Date.parse(w.resetsAt ?? "");
      if (Number.isFinite(resetAt)) weeklyResetAt = resetAt;
    }
  }
  return lowest === null ? null : { remainingPct: lowest, weeklyResetAt, ...(historical ? { historical: true } : {}) };
}

/**
 * Set each provider's display name from its remaining quota. A provider missing from `quotas`
 * gets its original name back. Returns the IDs whose name changed; `providers` is modified.
 */
export function applyQuotaLabels(
  providers: Record<string, ProviderConfig>,
  ids: string[],
  quotas: Map<string, Quota | null>,
  now = Date.now(),
): string[] {
  const changed: string[] = [];
  for (const id of ids) {
    const provider = providers[id];
    if (typeof provider?.label !== "string") continue;
    const next = withQuota(provider.label, quotas.get(id) ?? null, now);
    if (next === provider.label) continue;
    provider.label = next;
    changed.push(id);
  }
  return changed;
}
