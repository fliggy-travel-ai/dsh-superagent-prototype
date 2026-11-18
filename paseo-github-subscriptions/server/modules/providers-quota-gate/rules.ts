export interface QuotaWindow {
  id: string;
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

export function quotaProblems(account: AccountQuota | undefined, floor: number): string[] {
  if (!account) return [];
  const problems: string[] = [];
  if (account.error) problems.push(account.error);
  if (account.upstream?.error) problems.push(account.upstream.error);
  const windows = account.windows ?? [];
  const exhausted = account.allocationHint === 'avoid';
  const checkFloor = account.kind !== 'cursor' && account.kind !== 'antigravity' && !account.payableCredit;
  if (exhausted) problems.push('额度已耗尽（allocationHint avoid）');
  if (exhausted || checkFloor) {
    for (const window of windows) {
      if (exhausted ? window.remainingPct <= 0 : window.remainingPct < floor) {
        const label = /^[a-z0-9_-]{1,40}$/i.test(window.id) ? window.id : '额度';
        problems.push(`${label} 窗口剩余 ${window.remainingPct}%`);
      }
    }
  }
  return problems;
}

export function quotaUsable(account: AccountQuota | undefined, floor: number): boolean {
  return account?.allocationHint === 'normal' && quotaProblems(account, floor).length === 0;
}
