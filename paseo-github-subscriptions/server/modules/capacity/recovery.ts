import type { MigrationAgent, MigrationPort } from './migrate.ts';
import type { MigrationJournal } from './journal.ts';

/** 恢复失败时由调用方暂停迁移；容量快照与推送继续运行。 */
export async function recoverMigrations(journal: MigrationJournal, agents: MigrationAgent[], update: MigrationPort['update'], notify: MigrationPort['notify'], markAgent: boolean, read: MigrationPort['read']) {
  const byId = new Map(agents.map(agent => [agent.id, agent]));
  const ids = new Set(journal.entries().map(([id]) => id));
  for (const agent of agents) {
    if (agent.archivedAt) continue;
    const lease = agent.labels['dsh.migration-lease'];
    if (agent.labels['dsh.migration-state'] === 'needs_review' || (lease && !lease.startsWith('released:'))) ids.add(agent.id);
  }
  for (const id of ids) {
    const entry = journal.get(id);
    const agent = byId.get(id);
    if (entry?.state === 'in_progress' && entry.phase === 'locking') {
      if (!agent) { await journal.finish(id); continue; }
      if (agent.archivedAt) { await journal.finish(id); continue; }
      if (agent.labels['dsh.migration-lease'] === entry.lease) {
        if (!markAgent) continue;
        const value = `released:${Date.now()}`;
        await update(id, { 'dsh.migration-lease': value });
        if ((await read(id))?.labels['dsh.migration-lease'] !== value) throw Error('迁移锁读回失败');
      }
      await journal.finish(id);
      continue;
    }
    const reason = entry?.state === 'needs_review' ? entry.reason ?? 'needs_review' : 'interrupted';
    if (entry?.state !== 'needs_review') await journal.review(id, reason);
    let markFailed = false;
    if (markAgent && agent && !agent.archivedAt && agent.labels['dsh.migration-state'] !== 'needs_review') {
      try { await update(id, { 'dsh.migration-state': 'needs_review' }); } catch { markFailed = true; }
    }
    await notify('lb_exception', { oldAgentId: id, reason, trigger: entry?.trigger ?? null, autoResume: entry?.autoResume ?? null });
    if (markFailed) throw Error('无法标记待审会话');
  }
}
export function pruneCooldown(cooldown: Record<string, number>, now: number) {
  return Object.fromEntries(Object.entries(cooldown).filter(([, at]) => Number.isFinite(at) && at + 30 * 60_000 > now));
}

/** 人工核查后解除待审：先改标签并读回，再删除并读回本机记录。 */
export async function clearReview(journal: MigrationJournal, agentId: string, read: MigrationPort['read'], update: MigrationPort['update']) {
  const record = journal.get(agentId);
  if (!record || record.state !== 'needs_review') throw Error('会话没有待审记录');
  if (!await read(agentId)) throw Error('会话不存在');
  const released = `released:${Date.now()}`;
  const cleared = `cleared:${Date.now()}`;
  await update(agentId, { 'dsh.migration-state': cleared, 'dsh.migration-lease': released });
  const check = await read(agentId);
  if (check?.labels['dsh.migration-state'] !== cleared || check.labels['dsh.migration-lease'] !== released) throw Error('待审标签读回失败');
  await journal.finish(agentId);
  if (!await journal.verifyMissing(agentId)) throw Error('待审记录读回失败');
  return { ok: true, autoResume: record.autoResume ?? null };
}
