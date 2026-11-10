import type { MigrationAgent, MigrationPort } from './migrate.ts';
import type { MigrationJournal } from './journal.ts';

/** 恢复时先记录待审，再通知。任何一步失败都阻止启动迁移。 */
export async function recoverMigrations(journal: MigrationJournal, agents: MigrationAgent[], update: MigrationPort['update'], notify: MigrationPort['notify'], markAgent: boolean) {
  const byId = new Map(agents.map(agent => [agent.id, agent]));
  const ids = new Set(journal.entries().map(([id]) => id));
  for (const agent of agents) {
    const lease = agent.labels['dsh.migration-lease'];
    if (agent.labels['dsh.migration-state'] === 'needs_review' || (lease && !lease.startsWith('released:'))) ids.add(agent.id);
  }
  for (const id of ids) {
    const entry = journal.get(id);
    const reason = entry?.state === 'needs_review' ? entry.reason ?? 'needs_review' : 'interrupted';
    if (entry?.state !== 'needs_review') await journal.review(id, reason);
    const agent = byId.get(id);
    let markFailed = false;
    if (markAgent && agent && agent.labels['dsh.migration-state'] !== 'needs_review') {
      try { await update(id, { 'dsh.migration-state': 'needs_review' }); } catch { markFailed = true; }
    }
    await notify('lb_exception', { oldAgentId: id, reason });
    if (markFailed) throw Error('无法标记待审会话');
  }
}
export function pruneCooldown(cooldown: Record<string, number>, now: number) {
  return Object.fromEntries(Object.entries(cooldown).filter(([, at]) => Number.isFinite(at) && at + 30 * 60_000 > now));
}
