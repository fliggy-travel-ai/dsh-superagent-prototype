export type Tier = 'max' | 'pro';
export interface Window { id?: string; remainingPct?: number | null; usedPct?: number | null; resetsAt?: string | null }
export interface Report { id?: string; sourceId?: string; fetchedAt?: string; report?: { status?: string; planLabel?: string | null; windows?: Window[]; details?: Array<{ id?: string; value?: unknown }> }; lastSuccessful?: { fetchedAt?: string; report?: { status?: string; planLabel?: string | null; windows?: Window[] } } | null }
export interface Input { provider: string; report?: Report; configuredTier?: Tier; warmup?: boolean; agents: Array<{ id: string; status: string }>; now: number; liveMaxAgeMinutes?: number; paceEnabled?: boolean; excluded?: boolean }
/**
 * 档位识别（大小写不敏感）：「Max 5x」或只写「max」按 Max；「Max 20x」等其他倍数需要确认；「Pro…」按 Pro。
 * 实时报告里套餐标签缺失或认不出时（如新加账号），按配置档位，没有配置就按 Pro 保守计（2 个会话）。
 */
export function tierOf(label: string | null | undefined, configured?: Tier, live = false): { tier: Tier | null; reason: string | null } {
  let tier: Tier | null = null;
  const text = (label ?? '').trim();
  if (/^max\b/i.test(text)) { if (/^max\s*\d+x\b/i.test(text) && !/^max\s*5x\b/i.test(text)) return { tier: null, reason: 'Max 档次需要确认' }; tier = 'max'; }
  else if (/^pro\b/i.test(text)) tier = 'pro';
  if (!tier && live) return { tier: configured ?? 'pro', reason: null };
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
  const tierResult = tierOf(live ? report?.report?.planLabel : null, input.configuredTier, live);
  const displayed = !live && report?.lastSuccessful?.report ? { ...report, report: report.lastSuccessful.report } : report;
  const fiveHour = windowOf(displayed, 'five_hour'); const weekly = windowOf(displayed, 'weekly');
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
  let effectiveCap = eligible && !input.excluded ? base : 0;
  if (eligible && (fiveHour.remainingPct <= 0 || weekly.remainingPct <= 5)) effectiveCap = 0;
  else if (effectiveCap > 0 && input.paceEnabled !== false && pace > 1) effectiveCap = Math.floor(base / pace);
  const load = { total: input.agents.length, running: input.agents.filter(a => a.status === 'running').length, agentIds: input.agents.map(a => a.id) };
  const reason = input.excluded ? '已排除：不能用于主会话' : !live ? '额度非实时' : tierResult.reason ?? (!fiveHour || !weekly ? '额度窗口缺失' : null);
  return { provider: input.provider, tier, baseCap, warmup: !!input.warmup, fiveHour, weekly, live, fetchedAt: report?.fetchedAt ?? null, load, pace: Number.isFinite(pace) ? pace : null, effectiveCap, canAdd: Math.max(0, effectiveCap - load.total), reason, active_sessions: report?.report?.details?.find(d => d.id === 'active_sessions')?.value ?? null };
}
export type Account = ReturnType<typeof calculate>;
export function targets(accounts: Account[], source: string) {
  return accounts.filter(a => a.provider !== source && a.live && a.tier && a.canAdd >= 1 && (a.fiveHour?.remainingPct ?? -1) >= 30 && (a.weekly?.remainingPct ?? -1) >= 20)
    .sort((a, b) => b.canAdd - a.canAdd || (b.weekly?.remainingPct ?? 0) - (a.weekly?.remainingPct ?? 0) || Number(b.tier === 'max') - Number(a.tier === 'max') || a.provider.localeCompare(b.provider));
}
