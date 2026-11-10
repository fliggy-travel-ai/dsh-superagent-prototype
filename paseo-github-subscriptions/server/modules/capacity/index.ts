import { join } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createNotifier } from '../dispatch-finalize/notifier.ts';
import { signature, shouldPublish, type PublicationState } from './publisher.ts';
import type { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { capacitySnapshot } from '../../../shared/capacity.ts';
import { discover } from '../../vendor/paseo-0.15.0/claude-usage-source/server/usage.ts';
import { accountMap, providerEnvs } from '../usage-claude-accounts/account-map.ts';
import { isMainInstance, type Module } from '../types.ts';
import { calculate, targets, type Report } from './model.ts';
import { CapacitySchema, CAPACITY_DEFAULT, type CapacityConfig } from './config.ts';

export async function snapshot(client: DaemonClient, home: string, config: CapacityConfig, sourceId = 'claude-accounts') {
  const [reports, mapping] = await Promise.all([client.listUsageReports(), accountMap(home, discover)]);
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
    const page = await client.fetchAgents({ includeBackground: true, filter: { includeArchived: false }, page: { limit: 100, cursor } });
    agents.push(...page.entries.map(e => e.agent));
    if (!page.pageInfo.hasMore) break;
    if (!page.pageInfo.nextCursor || cursor === page.pageInfo.nextCursor) throw Error('会话列表不完整');
    cursor = page.pageInfo.nextCursor;
  } while (true);
  const now = Date.now();
  const accounts = [...providerEnvs(home).keys()].map(provider => {
    const key = mapping.get(provider);
    const report = key ? reports.reports.find(r => (r.sourceId === sourceId || r.sourceId === 'claude') && r.id === `${r.sourceId}:${key}`) : undefined;
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
    let state: PublicationState = null;
    let current: Promise<void> | null = null;
    let notifier: Awaited<ReturnType<typeof createNotifier>> | null = null;
    const readSnapshot = async () => {
      const config = context.machine.section<{ sourceId: string }>('claudeAccounts');
      return snapshot((await context.services.daemon.ready()).client, context.services.home, context.config, config.ok ? config.value.sourceId : 'claude-accounts');
    };
    context.server.handle(capacitySnapshot, readSnapshot);
    const start = (async () => {
      try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      notifier = await createNotifier(context.machine, directory);
      const publish = () => {
        if (stopped || current) return;
        current = (async () => {
          const data = await readSnapshot(); const now = Date.now(); const next = signature(data.accounts);
          if (!shouldPublish(state, next, now)) return;
          await notifier!.send('capacity', data, `capacity:${next}:${Math.floor(now / 3600_000)}`);
          state = { signature: next, sentAt: now };
          await mkdir(directory, { recursive: true, mode: 0o700 });
          await writeFile(`${statePath}.tmp`, JSON.stringify(state), { mode: 0o600 });
          await rename(`${statePath}.tmp`, statePath);
        })().catch(() => {}).finally(() => { current = null; });
      };
      publish();
      const timer = setInterval(publish, 60_000); timer.unref?.();
      return () => clearInterval(timer);
    })();
    void start.catch(error => context.fail(error));
    return async () => { stopped = true; const stop = await start.catch(() => null); stop?.(); await current; notifier?.stop(); };
  },
};
