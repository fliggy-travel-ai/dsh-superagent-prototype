import { randomUUID } from 'node:crypto';
import type { Account } from './model.ts';
import { targets } from './model.ts';

export interface MigrationAgent { id: string; provider: string; cwd: string; workspaceId?: string; model: string | null; currentModeId?: string | null; title: string | null; archivedAt?: string | null; labels: Record<string, string> }
export interface MigrationPort {
  read(id: string): Promise<MigrationAgent | null>;
  update(id: string, labels: Record<string, string>): Promise<void>;
  continueWork(id: string): Promise<void>;
  journal: { begin(id: string, lease: string, trigger: string): Promise<void>; markStarted(id: string): Promise<void>; saveResume(id: string, value: boolean): Promise<void>; review(id: string, reason: string): Promise<void>; finish(id: string): Promise<void> };
  stop(agent: MigrationAgent, reason: 'five_hour' | 'weekly', markWeeklyStop: () => void): Promise<boolean>;
  autoResume(id: string): Promise<boolean>;
  setAutoResume(id: string, enabled: boolean): Promise<void>;
  create(agent: MigrationAgent, provider: string, markRequest: () => void): Promise<string>;
  finalize(id: string): Promise<boolean>;
  verify(id: string): Promise<'ok' | 'quota' | 'unknown'>;
  children(id: string): Promise<string[]>;
  serverId(): string;
  archive(id: string): Promise<void>;
  audit(entry: Record<string, unknown>): Promise<void>;
  notify(event: 'main_migrated' | 'main_migration_planned' | 'lb_exception', data: Record<string, unknown>): Promise<void>;
  delay(ms: number): Promise<void>;
}
export function leaseActive(value: string | undefined, now: number): boolean {
  if (!value || value.startsWith('released:')) return false;
  const match = /^plugin:(\d+):/.exec(value);
  return !!match && Number(match[1]) > now;
}
export function triggerReason(account: Account, now: number): 'five_hour' | 'weekly' | null {
  if (!account.live || !account.tier || !account.fiveHour || !account.weekly) return null;
  const reset = Date.parse(account.fiveHour.resetsAt ?? '');
  if (account.fiveHour.remainingPct <= 0 && Number.isFinite(reset) && reset > now) return 'five_hour';
  return account.weekly.remainingPct <= 5 ? 'weekly' : null;
}
export async function migrate(port: MigrationPort, agent: MigrationAgent, accounts: Account[], mode: 'shadow' | 'live', now = Date.now()) {
  const source = accounts.find(a => a.provider === agent.provider.split('/')[0]);
  if (!source?.live || !source.tier || !source.fiveHour || !source.weekly || agent.labels.role !== 'main' || !(agent.labels.need || agent.labels.issue)) return 'ineligible';
  const reason = triggerReason(source, now);
  if (!reason) return 'ineligible';
  if (agent.labels['dsh.migration-state'] === 'needs_review') return 'needs_review';
  const candidates = targets(accounts, source.provider).slice(0, 2);
  const result = { oldAgentId: agent.id, fromProvider: source.provider, reason, needId: agent.labels.need || agent.labels.issue };
  if (agent.labels['dsh.lb'] === 'manual' || !candidates.length) {
    const why = agent.labels['dsh.lb'] === 'manual' ? 'manual' : 'no_target';
    await port.audit({ ...result, result: why, shadow: mode === 'shadow' });
    await port.notify('lb_exception', { ...result, reason: why, trigger: reason, autoResume: null, shadow: mode === 'shadow' }); return why;
  }
  if (mode === 'shadow') {
    await port.audit({ ...result, result: 'shadow', toProvider: candidates[0]!.provider });
    await port.notify('main_migration_planned', { ...result, toProvider: candidates[0]!.provider, shadow: true }); return 'shadow';
  }
  if (leaseActive(agent.labels['dsh.migration-lease'], now)) return 'locked';
  const lease = `plugin:${now + 30 * 60_000}:${randomUUID()}`;
  let acquired = false; let leaseAttempted = false; let lockReleased = false; let started = false; let releaseUncertain = false; let oldResume: boolean | undefined; let newId: string | undefined; let archived = false; let archiveUncertain = false; let review = false; let begun = false; let weeklyStopIssued = false; let creating = false; let inCreate = false; let pendingFailure: string | null = null;
  const moved: string[] = [];
  const step = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try { const value = await action(); await port.audit({ ...result, step: name, ok: true, elapsedMs: Date.now() - started }).catch(() => {}); return value; }
    catch (error) { await port.audit({ ...result, step: name, ok: false, elapsedMs: Date.now() - started }).catch(() => {}); throw error; }
  };
  const releaseOwn = async () => {
    const current = await port.read(agent.id);
    if (!current) throw Error('lease_unverified');
    if (current.labels['dsh.migration-lease'] !== lease) throw Error('lease_conflict');
    const released = `released:${Date.now()}`;
    await port.update(agent.id, { 'dsh.migration-lease': released });
    const confirmed = await port.read(agent.id);
    if (!confirmed || confirmed.labels['dsh.migration-lease'] !== released) throw Error('lease_unverified');
    lockReleased = true;
  };
  try {
    await port.journal.begin(agent.id, lease, reason); begun = true;
    leaseAttempted = true;
    await step('lease', () => port.update(agent.id, { 'dsh.migration-lease': lease }));
    await port.delay(2000);
    if ((await port.read(agent.id))?.labels['dsh.migration-lease'] !== lease) throw Error('lease_conflict');
    acquired = true;
    oldResume = await step('read_auto_resume', () => port.autoResume(agent.id));
    await port.journal.saveResume(agent.id, oldResume);
    await port.journal.markStarted(agent.id); started = true;
    await step('disable_auto_resume', () => port.setAutoResume(agent.id, false));
    if (!await step('stop', () => port.stop(agent, reason, () => { weeklyStopIssued = true; }))) throw Error('stop_unconfirmed');
    let chosen: Account | undefined;
    for (const candidate of candidates) {
      creating = false; inCreate = true;
      newId = await step('create', () => port.create(agent, candidate.provider, () => { creating = true; }));
      creating = false; inCreate = false;
      if (!await step('finalize', () => port.finalize(newId!))) throw Error('finalize_failed');
      const verification = await step('verify', () => port.verify(newId!));
      if (verification === 'ok') { chosen = candidate; break; }
      await port.archive(newId); newId = undefined;
      if (verification !== 'quota') throw Error('output_unknown');
    }
    if (!newId || !chosen) throw Error('no_healthy_target');
    const serverId = port.serverId();
    for (const id of await port.children(agent.id)) {
      moved.push(id); await step('reparent', () => port.update(id, { 'paseo.parent-agent-id': newId!, 'paseo.parent-server-id': serverId }));
      const child = await port.read(id);
      if (child?.labels['paseo.parent-agent-id'] !== newId || child.labels['paseo.parent-server-id'] !== serverId) throw Error('child_readback_failed');
    }
    try { await step('release_lease', releaseOwn); } catch { releaseUncertain = true; throw Error('lease_release_failed'); }
    try { await step('archive_original', () => port.archive(agent.id)); archived = true; }
    catch {
      const original = await port.read(agent.id).catch(() => null);
      if (!original) { archiveUncertain = true; throw Error('archive_unknown'); }
      if (original.archivedAt) archived = true;
      else throw Error('archive_failed');
    }
    await port.audit({ ...result, newAgentId: newId, toProvider: chosen.provider, result: 'migrated' });
    await port.notify('main_migrated', { ...result, newAgentId: newId, toProvider: chosen.provider });
    return 'migrated';
  } catch (error) {
    let rollbackIncomplete = false;
    if (!archived && !archiveUncertain) {
      for (const id of moved) {
        try {
          const serverId = port.serverId();
          await port.update(id, { 'paseo.parent-agent-id': agent.id, 'paseo.parent-server-id': serverId });
          const child = await port.read(id);
          if (child?.labels['paseo.parent-agent-id'] !== agent.id || child.labels['paseo.parent-server-id'] !== serverId) rollbackIncomplete = true;
        } catch { rollbackIncomplete = true; }
      }
      if (newId && !rollbackIncomplete) await port.archive(newId).catch(() => { rollbackIncomplete = true; });
      if (oldResume !== undefined) await port.setAutoResume(agent.id, oldResume).catch(() => { rollbackIncomplete = true; });
      if (weeklyStopIssued) await port.continueWork(agent.id).catch(() => { rollbackIncomplete = true; });
    }
    const known = ['lease_conflict', 'stop_unconfirmed', 'finalize_failed', 'output_unknown', 'no_healthy_target', 'child_readback_failed', 'resume_unavailable', 'source_unavailable', 'server_unavailable', 'list_incomplete', 'stopped', 'archive_unknown', 'archive_failed', 'lease_release_failed'];
    const failure = rollbackIncomplete ? 'rollback_incomplete' : creating ? 'create_unknown' : inCreate ? 'create_failed' : error instanceof Error && known.includes(error.message) ? error.message : 'operation_failed';
    review = archiveUncertain || rollbackIncomplete || creating || releaseUncertain;
    if (review && begun) { await port.journal.review(agent.id, failure).catch(() => {}); await port.update(agent.id, { 'dsh.migration-state': 'needs_review' }).catch(() => {}); }
    await port.audit({ ...result, result: failure });
    if (begun && !started && leaseAttempted && !review) { pendingFailure = failure; return failure; }
    await port.notify('lb_exception', { ...result, reason: failure, trigger: reason, autoResume: oldResume ?? null }); return failure;
  } finally {
    if (begun && !review) {
      if (!started && leaseAttempted && !lockReleased) {
        try {
          const current = await port.read(agent.id);
          if (!current) throw Error('lease_unverified');
          if (current.labels['dsh.migration-lease'] === lease) await releaseOwn();
        } catch {
          // 锁尚未确认，保留 locking 记录；恢复时只清理自己的锁。
          await port.notify('lb_exception', { ...result, reason: 'lock_unverified', trigger: reason, autoResume: oldResume ?? null }).catch(() => {});
          return 'lock_unverified';
        }
      } else if (started && acquired && !lockReleased) {
        try { await releaseOwn(); }
        catch {
          review = true;
          await port.journal.review(agent.id, 'lease_release_failed').catch(() => {});
          await port.update(agent.id, { 'dsh.migration-state': 'needs_review' }).catch(() => {});
          await port.notify('lb_exception', { ...result, reason: 'lease_release_failed', trigger: reason, autoResume: oldResume ?? null });
        }
      }
      if (pendingFailure) await port.notify('lb_exception', { ...result, reason: pendingFailure, trigger: reason, autoResume: oldResume ?? null });
      if (!review) await port.journal.finish(agent.id);
    }
  }
}
