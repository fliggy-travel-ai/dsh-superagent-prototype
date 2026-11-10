export type Tier = 'max' | 'pro';
export interface Window { id?: string; remainingPct?: number | null; usedPct?: number | null; resetsAt?: string | null }
export interface Report { id?: string; sourceId?: string; fetchedAt?: string; report?: { status?: string; planLabel?: string | null; windows?: Window[]; details?: Array<{ id?: string; value?: unknown }> }; lastSuccessful?: unknown }
export interface Input { provider: string; report?: Report; configuredTier?: Tier; warmup?: boolean; agents: Array<{ id: string; status: string }>; now: number; liveMaxAgeMinutes?: number; paceEnabled?: boolean }
export function tierOf(label: string | null | undefined, configured?: Tier): { tier: Tier | null; reason: string | null } {
  let tier: Tier | null = null;
  if (/^Max\b/.test(label ?? '')) { if (!/^Max 5x\b/i.test(label ?? '')) return { tier: null, reason: 'Max 档次需要确认' }; tier = 'max'; }
  else if (/^Pro\b/.test(label ?? '')) tier = 'pro';
  if (!tier) return { tier: null, reason: 'planLabel 未知' };
  if (configured && tier !== configured) return { tier: null, reason: '配置档次与实时档次不一致' };
  return { tier, reason: null };
}
function windowOf(report: Report | undefined, id: string) {
  const w = report?.report?.windows?.find(w => w.id === id);
  const value = w?.remainingPct ?? (w?.usedPct == null ? null : 100 - w.usedPct);
  if (value == null || !Number.isFinite(value) || value < 0 || value > 100) return null;
  return { remainingPct: value, resetsAt: w?.resetsAt ?? null };
}
export function calculate(input: Input) {
  const { report, now } = input;
  const at = Date.parse(report?.fetchedAt ?? '');
  const live = report?.report?.status === 'available' && Number.isFinite(at) && at <= now && now - at <= (input.liveMaxAgeMinutes ?? 10) * 60_000;
  const tierResult = tierOf(live ? report?.report?.planLabel : null, input.configuredTier);
  const fiveHour = windowOf(report, 'five_hour'); const weekly = windowOf(report, 'weekly');
  const eligible = live && tierResult.tier !== null && fiveHour !== null && weekly !== null;
  const tier = tierResult.tier;
  const baseCap = tier === 'max' ? 4 : tier === 'pro' ? 2 : 0;
  const base = input.warmup ? Math.floor(baseCap / 2) : baseCap;
  let pace = 0;
  if (eligible && fiveHour.resetsAt) {
    const reset = Date.parse(fiveHour.resetsAt);
    const elapsed = Math.max(0, Math.min(1, (now - (reset - 5 * 3600_000)) / (5 * 3600_000)));
    pace = Number.isFinite(reset) && elapsed > 0 ? (100 - fiveHour.remainingPct) / 100 / elapsed : (fiveHour.remainingPct < 100 ? Infinity : 0);
  }
  let effectiveCap = eligible ? base : 0;
  if (eligible && (fiveHour.remainingPct <= 0 || weekly.remainingPct <= 5)) effectiveCap = 0;
  else if (input.paceEnabled !== false && pace > 1) effectiveCap = Math.floor(base / pace);
  const load = { total: input.agents.length, running: input.agents.filter(a => a.status === 'running').length, agentIds: input.agents.map(a => a.id) };
  const reason = !live ? '额度非实时' : tierResult.reason ?? (!fiveHour || !weekly ? '额度窗口缺失' : null);
  return { provider: input.provider, tier, baseCap, warmup: !!input.warmup, fiveHour, weekly, live, fetchedAt: report?.fetchedAt ?? null, load, pace: Number.isFinite(pace) ? pace : null, effectiveCap, canAdd: Math.max(0, effectiveCap - load.total), reason, active_sessions: report?.report?.details?.find(d => d.id === 'active_sessions')?.value ?? null };
}
export type Account = ReturnType<typeof calculate>;
export function targets(accounts: Account[], source: string) {
  return accounts.filter(a => a.provider !== source && a.live && a.tier && a.canAdd >= 1 && (a.fiveHour?.remainingPct ?? -1) >= 30 && (a.weekly?.remainingPct ?? -1) >= 20)
    .sort((a, b) => b.canAdd - a.canAdd || (b.weekly?.remainingPct ?? 0) - (a.weekly?.remainingPct ?? 0) || Number(b.tier === 'max') - Number(a.tier === 'max') || a.provider.localeCompare(b.provider));
}
