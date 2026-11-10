import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MigrationWorker } from './worker.ts';
import { MigrationJournal } from './journal.ts';
import { recoverMigrations, pruneCooldown, clearReview } from './recovery.ts';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { onCapacityChange, capacityChanged } from './changes.ts';
import { createAuditWriter } from '../../notify/audit.ts';
import { migrate, triggerReason } from './migrate.ts';
import { daemonMigrationPort } from './daemon-migration.ts';
import { createNotifier } from '../dispatch-finalize/notifier.ts';
import { signature, shouldPublish, publicationKey, type PublicationState } from './publisher.ts';
import type { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { capacitySnapshot, capacityClearReview } from '../../../shared/capacity.ts';
import { ContinuousUsage } from '../usage-claude-accounts/continuous-usage.ts';
import { accountMap, providerEnvs } from '../usage-claude-accounts/account-map.ts';
import { isMainInstance, type Module } from '../types.ts';
import { calculate, targets, type Report } from './model.ts';
import { CapacitySchema, CAPACITY_DEFAULT, type CapacityConfig } from './config.ts';

export async function snapshot(client: DaemonClient, home: string, config: CapacityConfig, sourceId = 'claude-accounts', deps?: { mapping: Map<string, string>; providers: string[] }) {
  const usage = new ContinuousUsage({ home, directory: join(home, 'github-subscriptions', 'quota'), renewal: false });
  const [reports, mapping] = await Promise.all([client.listUsageReports(), deps ? Promise.resolve(deps.mapping) : accountMap(home, usage.discover)]);
  const workspaces = new Set<string>(); let cursor: string | undefined;
  do {
    const page = await client.fetchWorkspaces({ includeBackground: true, page: { limit: 100, cursor } });
    for (const w of page.entries) if (w.pinnedAt && !w.archivingAt) workspaces.add(w.id);
    if (!page.pageInfo.hasMore) break;
    if (!page.pageInfo.nextCursor || cursor === page.pageInfo.nextCursor) throw Error('工作区列表不完整');
    cursor = page.pageInfo.nextCursor;
  } while (true);
  const agents: Array<{ id: string; status: string; provider: string; workspaceId?: string | null; archivedAt?: string | null }> = [];
  cursor = undefined;
  do {
    const page: Awaited<ReturnType<DaemonClient['fetchAgents']>> = await client.fetchAgents({ includeBackground: true, filter: { includeArchived: false }, page: { limit: 100, cursor } });
    agents.push(...page.entries.map(e => e.agent));
    if (!page.pageInfo.hasMore) break;
    if (!page.pageInfo.nextCursor || cursor === page.pageInfo.nextCursor) throw Error('会话列表不完整');
    cursor = page.pageInfo.nextCursor;
  } while (true);
  const now = Date.now();
  const accounts = (deps?.providers ?? [...providerEnvs(home).keys()]).map(provider => {
    const key = mapping.get(provider);
    const report = key ? reports.reports.filter(r => (r.sourceId === sourceId || r.sourceId === 'claude') && r.id === `${r.sourceId}:${key}`).sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt))[0] : undefined;
    return calculate({ provider, report: report as Report | undefined, configuredTier: config.accounts[provider]?.tier, warmup: config.warmup.includes(provider), excluded: config.exclude.includes(provider), now, liveMaxAgeMinutes: config.liveMaxAgeMinutes, paceEnabled: config.pace,
      agents: agents.filter(a => !a.archivedAt && a.status !== 'closed' && !!a.workspaceId && workspaces.has(a.workspaceId) && a.provider.split('/')[0] === provider) });
  });
  const eligible = targets(accounts, '');
  const recommendedProvider: string | null = eligible.length ? eligible[0]!.provider : null;
  return { generatedAt: new Date(now).toISOString(), totalCanAdd: accounts.reduce((n, a) => n + a.canAdd, 0), recommendedProvider, accounts, excluded: accounts.filter(a => a.reason).map(a => ({ provider: a.provider, reason: a.reason! })) };
}
export function createCapacityModule(deps: { readSnapshot?: () => Promise<Awaited<ReturnType<typeof snapshot>>>; notifier?: typeof createNotifier; migrationPort?: typeof daemonMigrationPort } = {}): Module<CapacityConfig> {
 return {
  id: 'capacity.mainSessions', label: '主会话容量', defaultEnabled: false, appliesTo: isMainInstance,
  config: { section: 'capacity', spec: { schema: CapacitySchema, fallback: CAPACITY_DEFAULT } },
  register(context) {
    const directory = join(context.stateDirectory, 'capacity');
    const statePath = join(directory, 'publication.json');
    let stopped = false;
    const abort = new AbortController();
    const migrationPath = join(directory, 'migration-cooldown.json');
    const audit = createAuditWriter(join(directory, 'migrations.jsonl'));
    let cooldown: Record<string, number> = {};
    const journal = new MigrationJournal(join(directory, 'migrations-state.json'));
    let migrationWorker: MigrationWorker | null = null;
    let state: PublicationState = null;
    let current: Promise<void> | null = null;
    let pending = false;
    let notifier: Awaited<ReturnType<typeof createNotifier>> | null = null;
    let recoveryReady = false;
    let journalLoaded = false;
    let cooldownLoaded = false;
    const clearing = new Set<string>();
    const readSnapshot = async () => {
      if (deps.readSnapshot) return deps.readSnapshot();
      const config = context.machine.section<{ sourceId: string }>('claudeAccounts');
      return snapshot((await context.services.daemon.ready()).client, context.services.home, context.config, config.ok ? config.value.sourceId : 'claude-accounts');
    };
    context.server.handle(capacitySnapshot, readSnapshot);
    context.server.handle(capacityClearReview, async ({ agentId }) => {
      await start;
      if (!recoveryReady) throw Error('迁移恢复尚未完成');
      if (clearing.has(agentId)) throw Error('正在解除待审');
      clearing.add(agentId);
      try {
        const { client } = await context.services.daemon.ready();
        return await clearReview(journal, agentId, async id => (await client.fetchAgent(id))?.agent ?? null, (id, labels) => client.updateAgent(id, { labels }));
      } finally { clearing.delete(agentId); }
    });
    const start = (async () => {
      try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      notifier = await (deps.notifier ?? createNotifier)(context.machine, directory);
      const { client } = await context.services.daemon.ready();
      const port = (deps.migrationPort ?? daemonMigrationPort)(client, context.config.migration.handoffTemplate, audit,
        (event, body) => notifier!.send(event, event === 'lb_exception' ? { autoResume: null, trigger: null, ...body } : body, `${event}:${body.oldAgentId}:${body.reason ?? ''}:${event === 'lb_exception' && ['interrupted', 'needs_review'].includes(String(body.reason)) ? 'recovery' : randomUUID()}`), abort.signal, journal);
      const recover = async () => {
        try {
          if (!journalLoaded) { await journal.load(); journalLoaded = true; }
          if (!cooldownLoaded) {
            try {
              const value: unknown = JSON.parse(await readFile(migrationPath, 'utf8'));
              if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('冷却记录格式无效');
              cooldown = value as Record<string, number>;
            } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
            cooldownLoaded = true;
          }
          const agents = []; let cursor: string | undefined;
          do {
            const page: Awaited<ReturnType<DaemonClient['fetchAgents']>> = await client.fetchAgents({ includeBackground: true, filter: { includeArchived: true }, page: { limit: 100, cursor } });
            agents.push(...page.entries.map(entry => entry.agent));
            if (!page.pageInfo.hasMore) break;
            if (!page.pageInfo.nextCursor || page.pageInfo.nextCursor === cursor) throw Error('会话列表不完整');
            cursor = page.pageInfo.nextCursor;
          } while (true);
          await recoverMigrations(journal, agents, port.update, port.notify, context.config.migration.mode === 'live', port.read);
          recoveryReady = true;
        } catch {
          recoveryReady = false;
          console.error('[开发自动化·容量] 迁移恢复失败，已暂停迁移；容量推送继续。');
          await audit({ result: 'recovery_failed' }).catch(() => {});
          await notifier!.send('lb_exception', { reason: 'recovery_failed', autoResume: null }, `lb_exception:recovery_failed:${Math.floor(Date.now() / 3600_000)}`).catch(() => {});
        }
      };
      const saveCooldown = async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(`${migrationPath}.tmp`, JSON.stringify(cooldown), { mode: 0o600 });
        await rename(`${migrationPath}.tmp`, migrationPath);
      };
      migrationWorker = new MigrationWorker(async () => {
          if (!recoveryReady) await recover();
          if (!recoveryReady || stopped) return;
          const before = Object.keys(cooldown).length;
          cooldown = pruneCooldown(cooldown, Date.now());
          if (Object.keys(cooldown).length !== before) await saveCooldown();
          const mode = context.config.migration.mode;
          if (mode === 'off') return;
          const data = await readSnapshot();
          for (const account of data.accounts) {
            if (!triggerReason(account, Date.now())) continue;
            for (const id of account.load.agentIds) {
              if (stopped || cooldown[id] || journal.get(id)) continue;
              const agent = await port.read(id);
              if (!agent || agent.labels.role !== 'main' || !(agent.labels.need || agent.labels.issue)) continue;
              if (agent.labels['dsh.migration-state'] === 'needs_review') {
                await journal.review(id, 'needs_review');
                await port.notify('lb_exception', { oldAgentId: id, reason: 'needs_review' });
                continue;
              }
              const lease = agent.labels['dsh.migration-lease'];
              if (lease && !lease.startsWith('released:')) {
                await journal.review(id, 'interrupted');
                if (context.config.migration.mode === 'live') await port.update(id, { 'dsh.migration-state': 'needs_review' });
                await port.notify('lb_exception', { oldAgentId: id, reason: 'interrupted' });
                continue;
              }
              cooldown[id] = Date.now(); await saveCooldown();
              const result = await migrate(port, agent, data.accounts, mode);
              if (result === 'migrated') capacityChanged();
              if (result === 'lock_unverified') recoveryReady = false;
              return;
            }
          }
      });
      const publish = () => {
        if (stopped) return;
        if (current) { pending = true; return; }
        current = (async () => {
          const data = await readSnapshot(); const now = Date.now(); const next = signature(data.accounts);
          if (shouldPublish(state, next, now)) {
            await notifier!.send('capacity', data, publicationKey(next));
            state = { signature: next, sentAt: now };
            await mkdir(directory, { recursive: true, mode: 0o700 });
            await writeFile(`${statePath}.tmp`, JSON.stringify(state), { mode: 0o600 });
            await rename(`${statePath}.tmp`, statePath);
          }
          migrationWorker!.request();
        })().catch(() => {}).finally(() => { current = null; if (pending && !stopped) { pending = false; publish(); } });
      };
      const unsubscribe = onCapacityChange(publish);
      publish();
      const timer = setInterval(publish, 60_000); timer.unref?.();
      return () => { clearInterval(timer); unsubscribe(); };
    })();
    void start.catch(error => context.fail(error));
    return async () => { stopped = true; abort.abort(); const stop = await start.catch(() => null); stop?.(); await current; await migrationWorker?.stop(); notifier?.stop(); };
  },
 };
}
export const capacityModule = createCapacityModule();
