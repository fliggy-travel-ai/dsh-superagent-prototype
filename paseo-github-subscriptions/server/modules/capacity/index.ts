import { join } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { onCapacityChange, capacityChanged } from './changes.ts';
import { createAuditWriter } from '../../notify/audit.ts';
import { migrate } from './migrate.ts';
import { daemonMigrationPort } from './daemon-migration.ts';
import { createNotifier } from '../dispatch-finalize/notifier.ts';
import { signature, shouldPublish, type PublicationState } from './publisher.ts';
import type { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { capacitySnapshot } from '../../../shared/capacity.ts';
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
    return calculate({ provider, report: report as Report | undefined, configuredTier: config.accounts[provider]?.tier, warmup: config.warmup.includes(provider), now, liveMaxAgeMinutes: config.liveMaxAgeMinutes, paceEnabled: config.pace,
      agents: agents.filter(a => !a.archivedAt && a.status !== 'closed' && !!a.workspaceId && workspaces.has(a.workspaceId) && a.provider.split('/')[0] === provider) });
  });
  const eligible = targets(accounts, '');
  return { generatedAt: new Date(now).toISOString(), totalCanAdd: accounts.reduce((n, a) => n + a.canAdd, 0), recommendedProvider: eligible[0]?.provider ?? null, accounts, excluded: accounts.filter(a => a.reason).map(a => ({ provider: a.provider, reason: a.reason! })) };
}
export const capacityModule: Module<CapacityConfig> = {
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
    let state: PublicationState = null;
    let current: Promise<void> | null = null;
    let pending = false;
    let notifier: Awaited<ReturnType<typeof createNotifier>> | null = null;
    const readSnapshot = async () => {
      const config = context.machine.section<{ sourceId: string }>('claudeAccounts');
      return snapshot((await context.services.daemon.ready()).client, context.services.home, context.config, config.ok ? config.value.sourceId : 'claude-accounts');
    };
    context.server.handle(capacitySnapshot, readSnapshot);
    const start = (async () => {
      try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      try { cooldown = JSON.parse(await readFile(migrationPath, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      notifier = await createNotifier(context.machine, directory);
      const publish = () => {
        if (stopped) return;
        if (current) { pending = true; return; }
        current = (async () => {
          const data = await readSnapshot(); const now = Date.now(); const next = signature(data.accounts);
          if (shouldPublish(state, next, now)) {
          await notifier!.send('capacity', data, `capacity:${next}:${Math.floor(now / 3600_000)}`);
          state = { signature: next, sentAt: now };
          await mkdir(directory, { recursive: true, mode: 0o700 });
          await writeFile(`${statePath}.tmp`, JSON.stringify(state), { mode: 0o600 });
          await rename(`${statePath}.tmp`, statePath);
          }
          if (context.config.migration.mode !== 'off') {
            const { client } = await context.services.daemon.ready();
            const port = daemonMigrationPort(client, context.config.migration.handoffTemplate, audit,
              (event, body) => notifier!.send(event, body, `${event}:${body.oldAgentId}:${Date.now()}`), abort.signal);
            for (const account of data.accounts) {
              if (!account.live || !account.tier || !account.fiveHour || !account.weekly || (account.fiveHour.remainingPct > 0 && account.weekly.remainingPct > 5)) continue;
              for (const id of account.load.agentIds) {
                if (stopped || (cooldown[id] ?? 0) + 30 * 60_000 > Date.now()) continue;
                const agent = await port.read(id);
                if (!agent || agent.labels.role !== 'main' || !(agent.labels.need || agent.labels.issue)) continue;
                cooldown[id] = Date.now();
                await mkdir(directory, { recursive: true, mode: 0o700 });
                await writeFile(`${migrationPath}.tmp`, JSON.stringify(cooldown), { mode: 0o600 });
                await rename(`${migrationPath}.tmp`, migrationPath);
                if (await migrate(port, agent, data.accounts, context.config.migration.mode) === 'migrated') { capacityChanged(); return; }
              }
            }
          }
        })().catch(() => {}).finally(() => { current = null; if (pending && !stopped) { pending = false; publish(); } });
      };
      const unsubscribe = onCapacityChange(publish);
      publish();
      const timer = setInterval(publish, 60_000); timer.unref?.();
      return () => { clearInterval(timer); unsubscribe(); };
    })();
    void start.catch(error => context.fail(error));
    return async () => { stopped = true; abort.abort(); const stop = await start.catch(() => null); stop?.(); await current; notifier?.stop(); };
  },
};
