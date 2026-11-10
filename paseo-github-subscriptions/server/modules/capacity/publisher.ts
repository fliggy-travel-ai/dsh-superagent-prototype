import { createHash } from 'node:crypto';
import type { Account } from './model.ts';
export type PublicationState = { signature: string; sentAt: number } | null;
export function signature(accounts: Pick<Account, 'provider' | 'canAdd' | 'live'>[]) {
  const values = [...accounts].sort((a, b) => a.provider.localeCompare(b.provider)).map(a => [a.provider, a.canAdd, a.live]);
  return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 24);
}
export function shouldPublish(previous: PublicationState, next: string, now: number) {
  if (!previous) return true;
  const elapsed = now - previous.sentAt;
  return elapsed >= 6 * 3600_000 || (previous.signature !== next && elapsed >= 5 * 60_000);
}
