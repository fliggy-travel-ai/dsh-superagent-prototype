export interface QuotaWindow {
  id: string;
  /** 展示名，例如 7d、5h。额度来源把最紧的窗口改名为 effective，展示名保留原窗口。 */
  label?: string;
  remainingPct: number;
}

export interface AccountQuota {
  kind?: string;
  error?: string;
  upstream?: { error?: string };
  allocationHint?: 'normal' | 'unknown' | 'avoid';
  windows?: readonly QuotaWindow[];
  payableCredit?: boolean;
}

export function allocationHint(windows: readonly QuotaWindow[], pooled: boolean, payableCredit: boolean) {
  if (payableCredit) return 'normal';
  if (windows.length === 0) return 'unknown';
  const exhausted = (window: QuotaWindow) => window.remainingPct <= 0;
  return (pooled ? windows.every(exhausted) : windows.some(exhausted)) ? 'avoid' : 'normal';
}

function describe(window: QuotaWindow): string {
  const label = [window.label, window.id].find(value => value && /^[\w .:()-]{1,40}$/.test(value.trim()));
  return `${label?.trim() ?? '额度'} 窗口剩余 ${window.remainingPct}%`;
}

/** 拒绝创建的问题：账号报错、代理上游报错、登录失效或额度已耗尽。 */
export function quotaProblems(account: AccountQuota | undefined): string[] {
  if (!account) return [];
  const problems: string[] = [];
  if (account.error) problems.push(account.error);
  if (account.upstream?.error) problems.push(account.upstream.error);
  if (account.allocationHint === 'avoid') {
    problems.push('额度已耗尽（allocationHint avoid）');
    for (const window of account.windows ?? []) if (window.remainingPct <= 0) problems.push(describe(window));
  }
  return problems;
}

/** 只警告不拒绝：适用窗口低于阈值但还没用完。Cursor、Antigravity 和有付费余额的账号跳过阈值。 */
export function quotaWarnings(account: AccountQuota | undefined, floor: number): string[] {
  if (!account || account.allocationHint === 'avoid') return [];
  if (account.kind === 'cursor' || account.kind === 'antigravity' || account.payableCredit) return [];
  return (account.windows ?? []).filter(window => window.remainingPct < floor).map(describe);
}

/** 可推荐的备选账号：额度已确认、没有拒绝问题，也没有低于阈值的窗口。 */
export function quotaUsable(account: AccountQuota | undefined, floor: number): boolean {
  return account?.allocationHint === 'normal' && quotaProblems(account).length === 0 && quotaWarnings(account, floor).length === 0;
}
