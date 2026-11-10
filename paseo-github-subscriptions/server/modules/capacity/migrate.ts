import { randomUUID } from 'node:crypto';
import type { Account } from './model.ts';
import { targets } from './model.ts';

export interface MigrationAgent { id: string; provider: string; cwd: string; workspaceId?: string; model: string | null; title: string | null; archivedAt?: string | null; labels: Record<string, string> }
export interface MigrationPort {
  read(id: string): Promise<MigrationAgent | null>;
  update(id: string, labels: Record<string, string>): Promise<void>;
  stop(agent: MigrationAgent, reason: 'five_hour' | 'weekly'): Promise<boolean>;
  autoResume(id: string): Promise<boolean>;
  setAutoResume(id: string, enabled: boolean): Promise<void>;
  create(agent: MigrationAgent, provider: string): Promise<string>;
  finalize(id: string): Promise<boolean>;
  verify(id: string): Promise<'ok' | 'quota' | 'unknown'>;
  children(id: string): Promise<string[]>;
  serverId(): string;
  archive(id: string): Promise<void>;
  audit(entry: Record<string, unknown>): Promise<void>;
  notify(event: 'main_migrated' | 'lb_exception', data: Record<string, unknown>): Promise<void>;
  delay(ms: number): Promise<void>;
}
export function leaseActive(value: string | undefined, now: number): boolean {
  if (!value || value.startsWith('released:')) return false;
  const match = /^plugin:(\d+):/.exec(value);
  return !!match && Number(match[1]) > now;
}
export async function migrate(port: MigrationPort, agent: MigrationAgent, accounts: Account[], mode: 'shadow' | 'live', now = Date.now()) {
  const source = accounts.find(a => a.provider === agent.provider.split('/')[0]);
  if (!source?.live || !source.tier || !source.fiveHour || !source.weekly || agent.labels.role !== 'main' || !(agent.labels.need || agent.labels.issue)) return 'ineligible';
  const reason = source.fiveHour.remainingPct <= 0 ? 'five_hour' : source.weekly.remainingPct <= 5 ? 'weekly' : null;
  if (!reason) return 'ineligible';
  const candidates = targets(accounts, source.provider).slice(0, 2);
  const result = { oldAgentId: agent.id, fromProvider: source.provider, reason, needId: agent.labels.need || agent.labels.issue };
  if (agent.labels['dsh.lb'] === 'manual' || !candidates.length) {
    const why = agent.labels['dsh.lb'] === 'manual' ? 'manual' : 'no_target';
    await port.audit({ ...result, result: why, shadow: mode === 'shadow' });
    await port.notify('lb_exception', { ...result, reason: why, shadow: mode === 'shadow' }); return why;
  }
  if (mode === 'shadow') {
    await port.audit({ ...result, result: 'shadow', toProvider: candidates[0]!.provider });
    await port.notify('main_migrated', { ...result, toProvider: candidates[0]!.provider, shadow: true }); return 'shadow';
  }
  if (leaseActive(agent.labels['dsh.migration-lease'], now)) return 'locked';
  const lease = `plugin:${now + 30 * 60_000}:${randomUUID()}`;
  let acquired = false; let oldResume: boolean | undefined; let newId: string | undefined; let archived = false; let archiveUncertain = false;
  const moved: string[] = [];
  try {
    await port.update(agent.id, { 'dsh.migration-lease': lease });
    await port.delay(2000);
    if ((await port.read(agent.id))?.labels['dsh.migration-lease'] !== lease) throw Error('lease_conflict');
    acquired = true;
    oldResume = await port.autoResume(agent.id);
    await port.setAutoResume(agent.id, false);
    if (!await port.stop(agent, reason)) throw Error('stop_unconfirmed');
    let chosen: Account | undefined;
    for (const candidate of candidates) {
      newId = await port.create(agent, candidate.provider);
      if (!await port.finalize(newId)) throw Error('finalize_failed');
      const verification = await port.verify(newId);
      if (verification === 'ok') { chosen = candidate; break; }
      await port.archive(newId); newId = undefined;
      if (verification !== 'quota') throw Error('output_unknown');
    }
    if (!newId || !chosen) throw Error('no_healthy_target');
    const serverId = port.serverId();
    for (const id of await port.children(agent.id)) {
      moved.push(id); await port.update(id, { 'paseo.parent-agent-id': newId, 'paseo.parent-server-id': serverId });
      const child = await port.read(id);
      if (child?.labels['paseo.parent-agent-id'] !== newId || child.labels['paseo.parent-server-id'] !== serverId) throw Error('child_readback_failed');
    }
    try { await port.archive(agent.id); archived = true; }
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
    if (!archived && !archiveUncertain) {
      for (const id of moved) await port.update(id, { 'paseo.parent-agent-id': agent.id, 'paseo.parent-server-id': port.serverId() }).catch(() => {});
      if (newId) await port.archive(newId).catch(() => {});
      if (oldResume !== undefined) await port.setAutoResume(agent.id, oldResume).catch(() => {});
    }
    const known = ['lease_conflict', 'stop_unconfirmed', 'finalize_failed', 'output_unknown', 'no_healthy_target', 'child_readback_failed', 'resume_unavailable', 'source_unavailable', 'server_unavailable', 'list_incomplete', 'stopped', 'archive_unknown', 'archive_failed'];
    const failure = error instanceof Error && known.includes(error.message) ? error.message : 'operation_failed';
    await port.audit({ ...result, result: failure });
    await port.notify('lb_exception', { ...result, reason: failure }); return failure;
  } finally {
    if (acquired) await port.update(agent.id, { 'dsh.migration-lease': `released:${Date.now()}` }).catch(() => {});
  }
}
